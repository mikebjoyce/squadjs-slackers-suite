/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   COMMUNITY TOKEN CAP — TWO SERVERS, ONE BUCKET               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * The token bucket is one row per player for the whole community, and until now
 * `maxSwitchTokens` and the cooldown pair were read out of each process's own
 * `this.options`. Two admins who set different caps therefore had every one of
 * their servers recompute and write back the same shared row under a different
 * policy.
 *
 * This is the only failure in the multi-server work that reaches people who are
 * not admins. It needs no command, it throws nothing, and it writes nothing to
 * any log: `_regenTokens()` deliberately never clamps downward, so the
 * lower-capped server sees `room = 0`, takes the else branch, and stamps
 * `tokenRegenAnchor = now` on every appearance — destroying whatever regen
 * credit the higher-capped server had accrued. The higher-capped server goes on
 * telling the player a token is coming, indefinitely.
 *
 * The fix is not a refusal. You cannot decline a player's switch because two
 * admins disagree about a cap, so the three options resolve to one community
 * value — the lowest registered — and every read on every server uses it,
 * gameplay path included.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the asymmetric cap    A player at the lower cap, alternating between the two
 *                         servers, and what each server believes about them.
 *   the spend clock       The same spend starts the regen clock on one server
 *                         and not on the other, so the wait for the next token
 *                         depends on where the player happened to switch.
 *   the cooldown pair     Resolved together, because a per-key minimum invents
 *                         an interval neither server configured.
 *   the community of one  A single server resolves to its own values, which is
 *                         every stock install and must change nothing.
 *
 * Category: 1 (no external services)
 * Run:    node switch/testing/test-community-token-cap.js
 */

import assert from 'node:assert/strict';

import { summariseCommunityOptions } from '../../s3/utils/community-options.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

// switch.js imports S³'s plugin base as a flat sibling, which only resolves in
// the layout install.cjs produces.
const ASSEMBLY = buildAssembly('.tmp-switch-community-cap');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = 1_000_000_000_000;

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${String(err.message).split('\n').join('\n     ')}`);
    failed++;
  }
}

/** A registry row carrying one server's post-validation option values. */
function registryRow(serverID, alias, values) {
  return { serverID, alias, communityOptions: JSON.stringify(values) };
}

/**
 * One process's Switch plugin, holding only what the token routines touch.
 *
 * The prototype is the real class, so `_regenTokens`, `_spendToken` and
 * `_applyCommunityOptions` are the shipped implementations rather than a mock's
 * restatement of them — a mock that re-derives the regen algorithm cannot prove
 * anything about which cap the real one reads.
 */
function processFor(configured, registryRows) {
  const plugin = Object.create(Switch.prototype);
  plugin.options = { ...configured };
  plugin._configuredOptions = { ...configured };
  plugin._s3db = { communityOptions: summariseCommunityOptions(registryRows) };
  return plugin;
}

async function testSuite() {
  console.log('\n🧪 Community Token Cap — two servers, one bucket\n');

  const CAP_FIVE = { maxSwitchTokens: 5, switchCooldownMinutes: 0, switchCooldownHours: 1 };
  const CAP_THREE = { maxSwitchTokens: 3, switchCooldownMinutes: 0, switchCooldownHours: 1 };
  const REGISTRY = [
    registryRow(1, 'main', CAP_FIVE),
    registryRow(2, 'event', CAP_THREE)
  ];

  // ── The asymmetric cap ──────────────────────────────────────
  await runTest('a player at the lower cap gains nothing however long they alternate', () => {
    const a = processFor(CAP_FIVE, REGISTRY);
    const b = processFor(CAP_THREE, REGISTRY);

    // Before resolution, exactly the shipped-today behaviour.
    const row = { tokenBalance: 3, tokenRegenAnchor: new Date(BASE_TIME) };
    let now = BASE_TIME;
    const realNow = Date.now;
    try {
      // The player is on event for the first half of each hour and on main for
      // the second. Neither half is a whole interval on its own, and event
      // stamps the anchor forward every time it sees the row, so main's clock
      // never reaches one.
      for (let i = 0; i < 5; i++) {
        now += ONE_HOUR_MS / 2;
        Date.now = () => now;
        b._regenTokens(row);   // room = 0, so event stamps the anchor back to now

        now += ONE_HOUR_MS / 2;
        Date.now = () => now;
        a._regenTokens(row);   // room = 2, but only half an hour has passed
      }
    } finally {
      Date.now = realNow;
    }

    assert.strictEqual(
      row.tokenBalance, 3,
      'five hours at a one-hour interval and the balance has not moved once — the lower-capped server resets the anchor on every appearance'
    );
    assert.strictEqual(
      a.options.maxSwitchTokens, 5,
      'and main still believes the cap is 5, so it goes on telling the player a fourth token is coming'
    );

    // After resolution, both servers read the same cap.
    a._applyCommunityOptions();
    b._applyCommunityOptions();

    assert.strictEqual(a.options.maxSwitchTokens, 3, 'the lowest registered value, not this process’s own');
    assert.strictEqual(b.options.maxSwitchTokens, 3);
    assert.strictEqual(
      a.options.maxSwitchTokens, b.options.maxSwitchTokens,
      'a community-wide bucket has to have a community-wide cap, or one server is promising what the other takes away'
    );
  });

  // ── The spend clock ─────────────────────────────────────────
  await runTest('the same spend starts the regen clock on one server and not the other', () => {
    const a = processFor(CAP_FIVE, REGISTRY);
    const b = processFor(CAP_THREE, REGISTRY);

    // `_spendToken` resets the anchor only when the spend crossed the cap
    // boundary — `balance === maxTokens - 1`. With two caps in play the same
    // 3 → 2 spend crosses it on one server and not on the other, so the wait
    // for the next token depends on where the player happened to switch.
    const onA = { tokenBalance: 3, tokenRegenAnchor: new Date(BASE_TIME) };
    const onB = { tokenBalance: 3, tokenRegenAnchor: new Date(BASE_TIME) };

    const realNow = Date.now;
    const later = BASE_TIME + 30 * 60 * 1000;
    try {
      Date.now = () => later;
      a._spendToken(onA);
      b._spendToken(onB);
    } finally {
      Date.now = realNow;
    }

    assert.strictEqual(onA.tokenBalance, 2);
    assert.strictEqual(onB.tokenBalance, 2);
    assert.notStrictEqual(
      new Date(onA.tokenRegenAnchor).getTime(),
      new Date(onB.tokenRegenAnchor).getTime(),
      'the same spend against the same balance leaves two different anchors — half an hour of difference in when the token comes back'
    );

    // Resolved, the two servers cannot disagree about where the boundary is.
    a._applyCommunityOptions();
    b._applyCommunityOptions();

    const afterA = { tokenBalance: 3, tokenRegenAnchor: new Date(BASE_TIME) };
    const afterB = { tokenBalance: 3, tokenRegenAnchor: new Date(BASE_TIME) };
    try {
      Date.now = () => later;
      a._spendToken(afterA);
      b._spendToken(afterB);
    } finally {
      Date.now = realNow;
    }

    assert.strictEqual(
      new Date(afterA.tokenRegenAnchor).getTime(),
      new Date(afterB.tokenRegenAnchor).getTime(),
      'the player’s next token has to arrive at the same moment whichever server they were standing on'
    );
  });

  // ── The cooldown pair ───────────────────────────────────────
  await runTest('the cooldown pair resolves together, not key by key', () => {
    // main is 105 minutes (0 / 1.75), event is 30 (30 / 1). A per-key minimum
    // gives minutes 0 / hours 1 — an hour, which is neither.
    const rows = [
      registryRow(1, 'main', { switchCooldownMinutes: 0, switchCooldownHours: 1.75 }),
      registryRow(2, 'event', { switchCooldownMinutes: 30, switchCooldownHours: 1 })
    ];
    const plugin = processFor(
      { maxSwitchTokens: 2, switchCooldownMinutes: 0, switchCooldownHours: 1.75 },
      rows
    );
    plugin._applyCommunityOptions();

    assert.strictEqual(plugin.options.switchCooldownMinutes, 30);
    assert.strictEqual(plugin.options.switchCooldownHours, 1);

    // And the derived interval every read site computes is the stricter server's.
    const intervalMs = plugin.options.switchCooldownMinutes > 0
      ? plugin.options.switchCooldownMinutes * 60 * 1000
      : plugin.options.switchCooldownHours * ONE_HOUR_MS;
    assert.strictEqual(intervalMs, 30 * 60 * 1000, 'the resolved pair has to be a pair some server actually declared');
  });

  // ── The community of one ────────────────────────────────────
  await runTest('a single registered server keeps its own values', () => {
    const plugin = processFor(CAP_FIVE, [registryRow(1, 'main', CAP_FIVE)]);
    plugin._applyCommunityOptions();

    assert.strictEqual(
      plugin.options.maxSwitchTokens, 5,
      'every stock install is a community of one, and resolution must be invisible there'
    );
    assert.strictEqual(plugin.options.switchCooldownHours, 1);
  });

  await runTest('an empty registry leaves the configured values alone', () => {
    const plugin = processFor(CAP_FIVE, []);
    plugin._applyCommunityOptions();

    assert.strictEqual(
      plugin.options.maxSwitchTokens, 5,
      'no resolution means no community value, not zero — a boot before the registry has been read reads its own config'
    );
  });

  await runTest('losing the resolution restores the configured value rather than the last override', () => {
    const plugin = processFor(CAP_FIVE, REGISTRY);
    plugin._applyCommunityOptions();
    assert.strictEqual(plugin.options.maxSwitchTokens, 3);

    // S3 loses sight of the registry — the table is unreadable, or this is the
    // next boot before anything has been recorded into it. No candidate for the
    // group means no community value, and the question is what the server falls
    // back to: the 3 it inherited last time, or the 5 its operator typed.
    plugin._s3db.communityOptions = summariseCommunityOptions([]);
    plugin._applyCommunityOptions();

    assert.strictEqual(
      plugin.options.maxSwitchTokens, 5,
      'resolving against the current this.options instead of the configured snapshot would freeze the last override in place forever'
    );
  });

  console.log('');
  console.log(`  ${passed} passed, ${failed} failed`);
  cleanAssembly(ASSEMBLY);
  if (failed > 0) process.exitCode = 1;
}

await testSuite();
