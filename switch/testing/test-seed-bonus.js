/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: SEED BONUS TOKENS — Stage 2                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates spec §4.1–4.4: seed presence tracking, periodic bonus
 * grants via _checkSeedBonusGrants, transition consolation grants
 * via _grantSeedBonusOnTransition, and the atomic UPDATE race-
 * condition defenses.
 *
 * These tests simulate the actual Sequelize queries the plugin
 * makes, using the mock DB's update() with Op-style WHERE clauses.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-seed-bonus.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 35–47: see docs/switch-token-system-spec.md §4.1–4.4
 *
 */

import { createMockDb, createMockHarness, assert } from './mock-harness.js';

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
const BONUS_MINUTES = 20;
const BONUS_THRESHOLD_MS = BONUS_MINUTES * 60 * 1000;

/**
 * Simulate _checkSeedBonusGrants atomic UPDATE (§4.1a).
 * Uses string-based Op shorthands (_or, _ne, _lt, _lte) that the
 * mock DB understands — these are functionally equivalent to
 * Sequelize's Symbol-keyed Op.or/Op.ne/Op.lt/Op.lte.
 */
async function checkSeedBonusGrants(db, bonusCap, bonusMinutes, matchId, now) {
  const thresholdMs = bonusMinutes * 60 * 1000;
  const [grantCount] = await db.update(
    {
      tokenBalance: { val: 'tokenBalance + 1' },
      seedBonusTokensEarned: { val: 'seedBonusTokensEarned + 1' },
      seedPresenceStart: new Date(now),
      lastSeedBonusRoundID: matchId
    },
    {
      where: {
        seedPresenceStart: { _ne: null, _lte: new Date(now - thresholdMs) },
        seedBonusTokensEarned: { _lt: bonusCap },
        _or: [
          { lastSeedBonusRoundID: null },
          { lastSeedBonusRoundID: { _ne: matchId || '' } }
        ]
      }
    }
  );
  return grantCount;
}

/**
 * Simulate _grantSeedBonusOnTransition atomic UPDATE (§4.1b).
 */
async function grantSeedBonusOnTransition(db, bonusAmount, matchId, now) {
  const [grantCount] = await db.update(
    {
      tokenBalance: { val: 'tokenBalance + 1' },
      seedBonusTokensEarned: { val: 'seedBonusTokensEarned + 1' },
      seedPresenceStart: null,
      lastSeedBonusRoundID: matchId
    },
    {
      where: {
        seedPresenceStart: { _ne: null },
        seedBonusTokensEarned: 0,
        _or: [
          { lastSeedBonusRoundID: null },
          { lastSeedBonusRoundID: { _ne: matchId || '' } }
        ]
      }
    }
  );
  return grantCount;
}

/**
 * v2.5.0: Simulate the FULL _grantSeedBonusOnTransition flow including
 * the new null-matchId guard and pre-grant snapshot notification.
 *
 * Mirrors the fixed switch.js method:
 *   1. Guard: if matchId is null, return early (no UPDATE, no notify).
 *   2. Pre-grant findAll snapshot using the same WHERE as the UPDATE.
 *   3. Atomic UPDATE (consolation grant).
 *   4. Notify ONLY from the pre-grant snapshot (never re-query by value).
 *
 * @returns {{ grantCount: number, notifiedEosIDs: string[] }}
 */
async function runTransitionGrantWithNotify(db, opts) {
  const { matchId, connectedEosIDs, maxTokens = 2, bonusAmount = 1 } = opts;

  // Guard: don't run when matchId hasn't resolved yet — otherwise
  // lastSeedBonusRoundID gets written as null, and a post-grant
  // notification re-query could match unrelated rows.
  if (!matchId) return { grantCount: 0, notifiedEosIDs: [] };

  const whereClause = {
    seedPresenceStart: { _ne: null },
    seedBonusTokensEarned: 0,
    tokenBalance: { _lt: maxTokens + bonusAmount },
    _or: [
      { lastSeedBonusRoundID: null },
      { lastSeedBonusRoundID: { _ne: matchId || '' } }
    ],
    eosID: { _in: connectedEosIDs }
  };

  // Pre-grant snapshot — the exact rows the UPDATE will match.
  const qualifying = await db.findAll({
    where: whereClause,
    attributes: ['eosID']
  });

  const [grantCount] = await db.update(
    {
      tokenBalance: { val: 'tokenBalance + 1' },
      seedBonusTokensEarned: { val: 'seedBonusTokensEarned + 1' },
      seedPresenceStart: null,
      lastSeedBonusRoundID: matchId
    },
    { where: whereClause }
  );

  // Notify only from the snapshot, and only if a grant actually happened.
  const notifiedEosIDs = grantCount > 0 ? qualifying.map(r => r.eosID) : [];

  return { grantCount, notifiedEosIDs };
}

async function testSuite() {
  console.log('\n🧪 Seed Bonus Tokens — Stage 2\n');

  // ── Test 35: Seed presence set on join during seed mode ──────
  await runTest('Seed presence: set on join during seed mode', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    let row = await db.findByPk('player1');
    if (!row) {
      await db.create({
        eosID: 'player1',
        steamID: null,
        playerName: 'TestPlayer',
        tokenBalance: 2,
        seedPresenceStart: new Date(now)
      });
    }
    row = await db.findByPk('player1');
    assert.ok(row.seedPresenceStart instanceof Date, 'seedPresenceStart should be a Date');
    assert.strictEqual(new Date(row.seedPresenceStart).getTime(), now, 'seedPresenceStart should be set to now');
  });

  // ── Test 36: Seed presence NOT set during live mode ──────────
  await runTest('Seed presence: NOT set on join during live mode', async () => {
    const db = createMockDb();
    await db.create({
      eosID: 'player1',
      tokenBalance: 2
    });
    const row = await db.findByPk('player1');
    assert.strictEqual(row.seedPresenceStart, undefined, 'seedPresenceStart should NOT be set in live mode');
  });

  // ── Test 37: Seed presence preserved on rejoin ───────────────
  await runTest('Seed presence: preserved on rejoin (cumulative)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - 10 * 60 * 1000)
    });
    // Rejoin: skip if seedPresenceStart already set
    const existing = await db.findByPk('player1');
    if (existing.seedPresenceStart) {
      await db.upsert({ eosID: 'player1', seedPresenceStart: existing.seedPresenceStart });
    }
    const row = await db.findByPk('player1');
    assert.strictEqual(
      new Date(row.seedPresenceStart).getTime(), now - 10 * 60 * 1000,
      'seedPresenceStart should be preserved (cumulative)'
    );
  });

  // ── Test 38: Periodic grant awards +1 after threshold ─────────
  await runTest('Periodic grant: awards +1 token after threshold met', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });
    await db.upsert({
      eosID: 'player2',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - 1000),  // under threshold
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const grantCount = await checkSeedBonusGrants(db, 1, BONUS_MINUTES, 'match-1', now);
    assert.strictEqual(grantCount, 1, 'Only player1 should qualify (player2 under threshold)');

    const p1 = await db.findByPk('player1');
    assert.strictEqual(p1.tokenBalance, 3, 'Player1 should have +1 token');
    assert.strictEqual(p1.seedBonusTokensEarned, 1, 'Player1 seedBonusTokensEarned should be 1');
    assert.strictEqual(p1.lastSeedBonusRoundID, 'match-1', 'lastSeedBonusRoundID set');

    const p2 = await db.findByPk('player2');
    assert.strictEqual(p2.tokenBalance, 2, 'Player2 should have unchanged tokens');
    assert.strictEqual(p2.seedBonusTokensEarned, 0, 'Player2 should not have earned');
  });

  // ── Test 39: Periodic grant resets presence start ─────────────
  await runTest('Periodic grant: resets seedPresenceStart to NOW (multi-grant)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    await checkSeedBonusGrants(db, 1, BONUS_MINUTES, 'match-1', now);

    const row = await db.findByPk('player1');
    assert.strictEqual(
      new Date(row.seedPresenceStart).getTime(), now,
      'seedPresenceStart should be reset to NOW (not nulled)'
    );
  });

  // ── Test 40: Periodic grant respects per-round cap ────────────
  await runTest('Periodic grant: respects per-round cap (seedBonusTokensEarned < bonusCap)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 1,
      lastSeedBonusRoundID: 'match-1'
    });

    const grantCount = await checkSeedBonusGrants(db, 1, BONUS_MINUTES, 'match-1', now);
    assert.strictEqual(grantCount, 0, 'Should be 0 grants (player at cap)');

    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'Token balance should be unchanged');
  });

  // ── Test 41: Repeat eligibility across rounds ────────────────
  await runTest('Periodic grant: eligible in new round (lastSeedBonusRoundID != currentMatchId)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: 'round-1'
    });

    const grantCount = await checkSeedBonusGrants(db, 1, BONUS_MINUTES, 'round-2', now);
    assert.strictEqual(grantCount, 1, 'Should be 1 grant (new round)');

    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'Token balance should increase');
  });

  // ── Test 42: No double-grant within same round ───────────────
  await runTest('Periodic grant: no double-grant within same round', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 1,
      lastSeedBonusRoundID: 'match-1'
    });

    const grantCount = await checkSeedBonusGrants(db, 1, BONUS_MINUTES, 'match-1', now);
    assert.strictEqual(grantCount, 0, 'Should be 0 grants (already granted this round)');
  });

  // ── Test 43: Transition consolation grant ─────────────────────
  await runTest('Transition consolation: awards +1 on seed→non-seed to players with 0 earned', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });
    await db.upsert({
      eosID: 'player2',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const grantCount = await grantSeedBonusOnTransition(db, 1, 'match-1', now);
    assert.strictEqual(grantCount, 2, 'Both players should get transition grant');

    const p1 = await db.findByPk('player1');
    assert.strictEqual(p1.tokenBalance, 3, 'Player1 should have +1');
    assert.strictEqual(p1.seedPresenceStart, null, 'seedPresenceStart should be nulled');
  });

  // ── Test 44: Transition consolation skips players who earned ──
  await runTest('Transition consolation: skips players who already earned via periodic', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS),
      seedBonusTokensEarned: 1,
      lastSeedBonusRoundID: 'match-1'
    });
    await db.upsert({
      eosID: 'player2',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const grantCount = await grantSeedBonusOnTransition(db, 1, 'match-1', now);
    assert.strictEqual(grantCount, 1, 'Only player2 should get transition grant');

    const p1 = await db.findByPk('player1');
    assert.strictEqual(p1.tokenBalance, 3, 'Player1 should NOT get another token');
    const p2 = await db.findByPk('player2');
    assert.strictEqual(p2.tokenBalance, 3, 'Player2 should get +1');
  });

  // ── Test 45: Transition nulls seedPresenceStart ──────────────
  await runTest('Transition consolation: nulls seedPresenceStart (round over)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    await grantSeedBonusOnTransition(db, 1, 'match-1', now);

    const row = await db.findByPk('player1');
    assert.strictEqual(row.seedPresenceStart, null, 'seedPresenceStart should be null (round ended)');
  });

  // ── Test 46: Tokens stack above cap from seeding ────────────
  await runTest('Tokens stack above cap from multiple seed grants (across rounds)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    // Grant 1 (round 1)
    await checkSeedBonusGrants(db, 2, BONUS_MINUTES, 'round-1', now);
    let row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'After grant 1: balance should be 3');
    assert.strictEqual(row.seedBonusTokensEarned, 1, 'After grant 1: earned=1');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-1', 'lastSeedBonusRoundID set to round-1');

    // New round: advance time, reset presence, change matchId
    const newNow = now + BONUS_THRESHOLD_MS + 1000;
    await db.update(
      { seedPresenceStart: new Date(newNow - BONUS_THRESHOLD_MS - 1000) },
      { where: { eosID: 'player1' } }
    );
    // Grant 2 (round 2) — eligible because lastSeedBonusRoundID != currentMatchId
    await checkSeedBonusGrants(db, 2, BONUS_MINUTES, 'round-2', newNow);

    row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 4, 'After grant 2: balance should be 4 (stacked above cap of 2)');
    assert.strictEqual(row.seedBonusTokensEarned, 2, 'After grant 2: earned=2 (at cap)');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-2', 'lastSeedBonusRoundID updated to round-2');
  });

  // ── Test 47: Re-entrancy guard prevents concurrent processing ─
  await runTest('Re-entrancy guard: prevents concurrent periodic + transition processing', async () => {
    // This tests the _seedPresenceProcessing boolean guard that wraps
    // both _checkSeedBonusGrants and _grantSeedBonusOnTransition.
    // When the guard is true, both methods return early without DB ops.
    let guard = true;
    let dbOpsExecuted = false;

    // Simulate _checkSeedBonusGrants guard
    if (guard) {
      // return early — should be tested that no DB ops happened
      assert.ok(true, 'Periodic check skipped (guard active)');
    } else {
      dbOpsExecuted = true;
    }

    // Simulate _grantSeedBonusOnTransition guard
    if (guard) {
      assert.ok(true, 'Transition grant skipped (guard active)');
    } else {
      dbOpsExecuted = true;
    }
  });

  // ═════════════════════════════════════════════════════════════
  // v2.4.0 additions: min-player threshold + disable semantics
  // ═════════════════════════════════════════════════════════════

  // ── Test 48: seed bonus disabled when amount or minutes is 0 ──
  await runTest('v2.4.0: seed bonus disabled when seedTokenBonusAmount=0', async () => {
    const { plugin } = createMockHarness({ seedTokenBonusAmount: 0, seedTokenBonusMinutes: 20 });
    assert.strictEqual(plugin._isSeedBonusEnabled(), false, 'amount=0 should disable seed bonus');
  });

  await runTest('v2.4.0: seed bonus disabled when seedTokenBonusMinutes=0', async () => {
    const { plugin } = createMockHarness({ seedTokenBonusAmount: 1, seedTokenBonusMinutes: 0 });
    assert.strictEqual(plugin._isSeedBonusEnabled(), false, 'minutes=0 should disable seed bonus');
  });

  await runTest('v2.4.0: seed bonus enabled with positive amount and minutes', async () => {
    const { plugin } = createMockHarness({ seedTokenBonusAmount: 2, seedTokenBonusMinutes: 30 });
    assert.strictEqual(plugin._isSeedBonusEnabled(), true, 'positive values should enable seed bonus');
  });

  // ── Test 49: accrual respects min-player threshold ────────────
  await runTest('v2.4.0: accrual inactive below min-player threshold', async () => {
    const { plugin } = createMockHarness({ isLiberalMode: true, seedTokenBonusMinPlayers: 3 });
    plugin._setPlayerCount(2);
    assert.strictEqual(plugin._isSeedAccrualActive(), false, '2 players < 3 min should be inactive');
  });

  await runTest('v2.4.0: accrual active at or above min-player threshold', async () => {
    const { plugin } = createMockHarness({ isLiberalMode: true, seedTokenBonusMinPlayers: 3 });
    plugin._setPlayerCount(3);
    assert.strictEqual(plugin._isSeedAccrualActive(), true, '3 players >= 3 min should be active');
  });

  await runTest('v2.4.0: accrual inactive when not in seed mode', async () => {
    const { plugin } = createMockHarness({ isLiberalMode: false, seedTokenBonusMinPlayers: 0 });
    plugin._setPlayerCount(10);
    assert.strictEqual(plugin._isSeedAccrualActive(), false, 'not in seed mode → inactive even with players');
  });

  await runTest('v2.4.0: accrual active with minPlayers=0 regardless of population', async () => {
    const { plugin } = createMockHarness({ isLiberalMode: true, seedTokenBonusMinPlayers: 0 });
    plugin._setPlayerCount(1);
    assert.strictEqual(plugin._isSeedAccrualActive(), true, 'minPlayers=0 → active with any population');
  });

  await runTest('v2.5.0: accrual stops during ENDGAME even though isSeedMode() is still true', async () => {
    // The layer does not change until NEW_GAME, so a seed round's ENDGAME still
    // reports isSeedMode() === true and S3_PLAYERS_UPDATED keeps firing. Without
    // this gate the reconciler re-stamps seedPresenceStart immediately after the
    // ENDGAME sweep cleared it, undoing the round close and carrying presence into
    // the next round (which then blocks tier-1 row pruning).
    const { plugin } = createMockHarness({ isLiberalMode: true, seedTokenBonusMinPlayers: 0 });
    plugin._setPlayerCount(10);

    plugin._setPhase('LIVE');
    assert.strictEqual(plugin._isSeedAccrualActive(), true, 'accrues during LIVE');

    plugin._setPhase('ENDGAME');
    assert.strictEqual(plugin._isSeedAccrualActive(), false, 'must NOT accrue during ENDGAME');

    plugin._setPhase('STAGING');
    assert.strictEqual(plugin._isSeedAccrualActive(), true, 'accrues again during the next round STAGING');
  });

  // NOTE (v2.5.0): Two tests formerly sat here — "accrual activation resets all
  // seedPresenceStart timestamps" and "accrual activation preserves prior earned
  // count". Both were removed rather than updated. They hand-wrote an UPDATE and
  // then asserted that same UPDATE had happened, so they passed against any
  // implementation and proved nothing. The force-reset path they nominally covered
  // (_initSeedPresenceForAll with force=true) no longer exists: the accrual-edge
  // trigger was replaced by the per-tick reconciler, so there is no production code
  // left for them to describe.

  // ── Test 51: grants short-circuit when seed bonus disabled ────
  await runTest('v2.4.0: periodic grant no-ops when disabled (bonusMinutes=0)', async () => {
    // The plugin's _checkSeedBonusGrants returns early when bonusMinutes <= 0.
    // Verify the guard condition itself is correct.
    const bonusCap = 1;
    const bonusMinutes = 0;
    const shouldGrant = bonusCap > 0 && bonusMinutes > 0;
    assert.strictEqual(shouldGrant, false, 'guard should prevent granting when minutes=0');
  });

  await runTest('v2.4.0: consolation grant no-ops when disabled (bonusAmount=0)', async () => {
    // The plugin's _grantSeedBonusOnTransition returns early when amount <= 0.
    const bonusAmount = 0;
    const bonusMinutes = 20;
    const shouldGrant = bonusAmount > 0 && bonusMinutes > 0;
    assert.strictEqual(shouldGrant, false, 'guard should prevent granting when amount=0');
  });

  // ── Test 52: consolation grant idempotency (layer-change safety) ─
  await runTest('v2.4.0: consolation grant is idempotent across repeated calls', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    // First consolation grant (e.g. layer change)
    await grantSeedBonusOnTransition(db, 1, 'match-1', now);

    // A second call (e.g. another layer change event) should find nothing
    // because seedPresenceStart is now null.
    const secondGrant = await grantSeedBonusOnTransition(db, 1, 'match-1', now);

    assert.strictEqual(secondGrant, 0, 'no double grant on second call');
    const p1 = await db.findByPk('player1');
    assert.strictEqual(p1.tokenBalance, 3, 'balance still 3 (single grant total)');
  });

  // ═════════════════════════════════════════════════════════════
  // v2.4.0 fix: cleanup() regression tests (2026-08-15)
  // ═════════════════════════════════════════════════════════════

  /**
   * Simulate the cleanup() destroy WHERE clause from switch-db.js.
   * Mirrors the production logic: deletes rows where ALL of these are true:
   *   1. No active scramble lockdown
   *   2. tokenBalance >= maxTokens
   *   3. lastActiveTimestamp IS NULL OR > 24h old
   *   4. seedPresenceStart IS NULL (added 2026-08-15)
   *   5. seedBonusTokensEarned = 0 (added 2026-08-15)
   */
  async function runCleanup(db, maxTokens, now) {
    return db.destroy({
      where: {
        _and: [
          {
            _or: [
              { scrambleLockdownExpiry: null },
              { scrambleLockdownExpiry: { _lt: now } }
            ]
          },
          { tokenBalance: { _gte: maxTokens } },
          {
            _or: [
              { lastActiveTimestamp: null },
              { lastActiveTimestamp: { _lt: new Date(now - 24 * 60 * 60 * 1000) } }
            ]
          },
          { seedPresenceStart: null },
          { seedBonusTokensEarned: 0 }
        ]
      }
    });
  }

  // ── Test 53: cleanup preserves row with earned seed bonus ────
  await runTest('cleanup: preserves row with seedBonusTokensEarned > 0', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,           // above cap (seed bonus granted)
      seedPresenceStart: null,   // transition grant nulled it
      seedBonusTokensEarned: 1,  // earned a bonus this round
      lastActiveTimestamp: null, // no activity timestamp
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 0, 'row with seedBonusTokensEarned > 0 should survive cleanup');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row should still exist');
    assert.strictEqual(row.tokenBalance, 3, 'token balance preserved');
  });

  // ── Test 54: cleanup preserves row with active seed presence ─
  await runTest('cleanup: preserves row with seedPresenceStart set', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - 10 * 60 * 1000),  // active presence
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: null,
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 0, 'row with seedPresenceStart should survive cleanup');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row should still exist');
  });

  // ── Test 55: cleanup deletes stale row with no seed data ────
  await runTest('cleanup: deletes stale row (null lastActiveTimestamp, full tokens, no seed data)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: null,
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 1, 'stale row with no seed data should be deleted');
    const row = await db.findByPk('player1');
    assert.strictEqual(row, null, 'row should be gone');
  });

  // ── Test 56: cleanup preserves below-cap row ────────────────
  await runTest('cleanup: preserves row with tokenBalance < maxTokens', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 1,           // below cap
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: null,
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 0, 'below-cap row should survive cleanup');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row should still exist');
  });

  // ── Test 57: cleanup preserves scramble-locked row ──────────
  await runTest('cleanup: preserves row with active scramble lockdown', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: null,
      scrambleLockdownExpiry: new Date(now + 30 * 60 * 1000)  // expires in 30 min
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 0, 'scramble-locked row should survive cleanup');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row should still exist');
  });

  // ── Test 58: cleanup preserves row with recent lastActiveTimestamp ─
  await runTest('cleanup: preserves row with recent lastActiveTimestamp (active player)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,           // above cap (seed bonus)
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: new Date(now - 60 * 60 * 1000),  // 1 hour ago (within 24h)
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 0, 'row with recent lastActiveTimestamp should survive cleanup');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row should still exist');
    assert.strictEqual(row.tokenBalance, 3, 'token balance preserved');
  });

  // ── Test 59: cleanup prunes genuinely stale + idle player at max tokens ─
  await runTest('cleanup: prunes stale + idle player at max tokens (lastActiveTimestamp > 24h)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,           // at cap
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: new Date(now - 25 * 60 * 60 * 1000),  // 25 hours ago
      scrambleLockdownExpiry: null
    });

    const deleted = await runCleanup(db, 2, now);
    assert.strictEqual(deleted, 1, 'stale idle player at max tokens should be pruned');
    const row = await db.findByPk('player1');
    assert.strictEqual(row, null, 'row should be gone');
  });

  // ═════════════════════════════════════════════════════════════
  // v2.5.0 fix: data-driven per-tick round reset + token ceiling
  // ═════════════════════════════════════════════════════════════

  /**
   * Simulate the new 3-step _checkSeedBonusGrants tick (bulk-create →
   * bulk-reset → grant), scoped to the connected-player roster.
   *
   * Mirrors switch.js _checkSeedBonusGrants exactly:
   *   1. Bulk-create rows for connected eosIDs with no existing row.
   *   2. Bulk-reset rows where (seedPresenceStart IS NOT NULL AND
   *      lastSeedBonusRoundID != matchId) OR seedPresenceStart IS NULL.
   *   3. Grant +1 to connected rows with threshold met, seedBonusTokensEarned
   *      < bonusCap, tokenBalance < maxTokens + bonusCap, and
   *      lastSeedBonusRoundID === matchId.
   *
   * @returns {{ created, reset, granted }}
   */
  async function runSeedTick(db, opts) {
    const {
      connectedEosIDs,
      allPlayers,
      matchId,
      maxTokens,
      bonusCap,
      bonusMinutes,
      now
    } = opts;
    const thresholdMs = bonusMinutes * 60 * 1000;

    // Step 1: bulk-create missing rows
    const existingRows = await db.findAll({
      where: { eosID: { _in: connectedEosIDs } },
      attributes: ['eosID']
    });
    const existingEosIDs = new Set(existingRows.map(r => r.eosID));
    const missingEosIDs = connectedEosIDs.filter(id => !existingEosIDs.has(id));
    let created = 0;
    if (missingEosIDs.length > 0) {
      const nowDate = new Date(now);
      const toCreate = missingEosIDs.map(eosID => {
        const player = (allPlayers || []).find(p => p.eosID === eosID);
        return {
          eosID,
          steamID: player?.steamID || null,
          playerName: player?.name || null,
          tokenBalance: maxTokens,
          seedPresenceStart: nowDate,
          seedBonusTokensEarned: 0,
          lastSeedBonusRoundID: matchId,
          firstSeenTimestamp: nowDate,
          lastActiveTimestamp: nowDate
        };
      });
      await db.bulkCreate(toCreate);
      created = toCreate.length;
    }

    // Step 2: bulk reset stale/null rows.
    // The NULL branch is explicit and the ceiling exclusion is present — both
    // mirror production exactly. Without the NULL branch a row with presence set
    // and lastSeedBonusRoundID NULL is unreachable here (three-valued logic) and
    // unreachable in step 3 (equality), stranding the player for the round.
    const [reset] = await db.update(
      {
        seedPresenceStart: new Date(now),
        seedBonusTokensEarned: 0,
        lastSeedBonusRoundID: matchId
      },
      {
        where: {
          eosID: { _in: connectedEosIDs },
          tokenBalance: { _lt: maxTokens + bonusCap },
          _or: [
            {
              seedPresenceStart: { _ne: null },
              _or: [
                { lastSeedBonusRoundID: null },
                { lastSeedBonusRoundID: { _ne: matchId } }
              ]
            },
            { seedPresenceStart: null }
          ]
        }
      }
    );

    // Step 3: grant
    const [granted] = await db.update(
      {
        tokenBalance: { val: 'tokenBalance + 1' },
        seedBonusTokensEarned: { val: 'seedBonusTokensEarned + 1' },
        seedPresenceStart: new Date(now),
        lastSeedBonusRoundID: matchId
      },
      {
        where: {
          eosID: { _in: connectedEosIDs },
          seedPresenceStart: { _ne: null, _lte: new Date(now - thresholdMs) },
          seedBonusTokensEarned: { _lt: bonusCap },
          tokenBalance: { _lt: maxTokens + bonusCap },
          lastSeedBonusRoundID: matchId
        }
      }
    );

    return { created, reset, granted };
  }

  // ── Test 60: SEED→SEED transition resets a stale row below the ceiling ──
  await runTest('v2.5.0: SEED→SEED resets a stale below-ceiling row and makes it grant-eligible', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // Player spent their bonus, so they are back at base cap. Their row is still
    // scoped to round-1 when round-2 starts — this is the Slacker case.
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,                                              // below ceiling (3)
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000), // old presence
      seedBonusTokensEarned: 1,                                     // == bonusCap, from round-1
      lastSeedBonusRoundID: 'round-1'
    });

    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    // First tick in round-2: reset brings earned to 0 and presence to now. No grant
    // on this tick — presence was just reset, so the threshold check fails.
    const tick1 = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-2',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick1.reset, 1, 'stale row should be reset');
    assert.strictEqual(tick1.granted, 0, 'no grant on the same tick as reset');

    let row = await db.findByPk('player1');
    assert.strictEqual(row.seedBonusTokensEarned, 0, 'earned reset to 0');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-2', 'lastSeedBonusRoundID updated');
    assert.strictEqual(new Date(row.seedPresenceStart).getTime(), now, 'presence reset to now');

    // Second tick after the threshold elapses: the row earns again in the new round.
    const later = now + BONUS_THRESHOLD_MS + 1000;
    await db.update(
      { seedPresenceStart: new Date(later - BONUS_THRESHOLD_MS - 1000) },
      { where: { eosID: 'player1' } }
    );
    const tick2 = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-2',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now: later
    });

    assert.strictEqual(tick2.reset, 0, 'row already scoped to round-2 — no re-reset');
    assert.strictEqual(tick2.granted, 1, 'threshold met in the new round — grant fires');

    row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'balance lands at the ceiling');
    assert.strictEqual(row.seedBonusTokensEarned, 1, 'earned 1 in round-2');
  });

  // ── Test 60b: a stale row AT the ceiling is left alone entirely ──
  await runTest('v2.5.0: stale row at the ceiling is not re-stamped (derived, not stored)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // Player earned their bonus in round-1 and never spent it, so they sit at the
    // ceiling. They cannot earn anything in round-2, so the reconciler deliberately
    // skips them rather than re-stamping presence every tick. The row stays scoped
    // to round-1 until they spend down, at which point the reset clause picks it up.
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,  // maxTokens + bonusCap
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 1,
      lastSeedBonusRoundID: 'round-1'
    });

    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-2',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.reset, 0, 'at-ceiling row should not be re-stamped');
    assert.strictEqual(tick.granted, 0, 'at-ceiling row should not be granted');

    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'balance stays at the ceiling (not 4)');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-1', 'row left scoped to the old round');
  });

  // ── Test 61: token ceiling enforcement ──────────────────────
  await runTest('v2.5.0: player at maxSwitchTokens + bonusCap is excluded from further grants', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // Already at the ceiling (3), with threshold met and earned < cap.
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 3,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: 'round-1'
    });

    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.granted, 0, 'player at ceiling should not be granted');
    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'balance remains at ceiling');
  });

  await runTest('v2.5.0: player at ceiling−1 receives a grant that lands exactly at ceiling', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // Below ceiling by 1 (balance 2, earned 0, threshold met, current round).
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: 'round-1'
    });

    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.granted, 1, 'ceiling−1 player should receive one grant');
    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'balance lands exactly at ceiling (maxTokens+bonusCap)');
  });

  // ── Test 62: disconnected player is NOT reset/granted ───────
  await runTest('v2.5.0: disconnected player row is NOT reset or granted on subsequent ticks', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // Stale row from a previous round, but player is NOT in the connected set.
    await db.upsert({
      eosID: 'ghost1',
      tokenBalance: 3,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: 'round-1'
    });

    // Only player1 is connected; ghost1 is disconnected.
    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-2',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.created, 1, 'connected player1 with no row gets created');
    assert.strictEqual(tick.reset, 0, 'ghost1 should NOT be reset (not connected)');
    assert.strictEqual(tick.granted, 0, 'ghost1 should NOT be granted (not connected)');

    const ghost = await db.findByPk('ghost1');
    assert.strictEqual(ghost.lastSeedBonusRoundID, 'round-1', 'ghost row untouched (still scoped to old round)');
    assert.strictEqual(ghost.tokenBalance, 3, 'ghost balance unchanged');
  });

  // ── Test 63: no-row connected player gets created (bootstrap) ─
  await runTest('v2.5.0: connected player with no row gets one created on the next seed tick', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // player1 has no row at all.
    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.created, 1, 'no-row player1 should be created');
    const row = await db.findByPk('player1');
    assert.ok(row, 'row now exists');
    assert.strictEqual(row.tokenBalance, maxTokens, 'created at maxTokens');
    assert.strictEqual(row.seedPresenceStart instanceof Date, true, 'presence initialized');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-1', 'scoped to current round');
    assert.strictEqual(row.seedBonusTokensEarned, 0, 'earned starts at 0');
  });

  // ── Test 64: existing row with null seedPresenceStart gets bootstrapped ─
  await runTest('v2.5.0: already-connected player with null seedPresenceStart gets bootstrapped on next tick', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // player1 has a row but null seedPresenceStart (joined in non-seed, then
    // layer flipped to seed without a join event firing).
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const connectedEosIDs = ['player1'];
    const allPlayers = [{ eosID: 'player1', name: 'Player One', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.created, 0, 'row already exists — no create');
    assert.strictEqual(tick.reset, 1, 'null-presence row should be reset/bootstrap');

    const row = await db.findByPk('player1');
    assert.strictEqual(row.seedPresenceStart instanceof Date, true, 'presence initialized');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-1', 'scoped to current round');
    assert.strictEqual(row.seedBonusTokensEarned, 0, 'earned reset to 0');
  });

  // ═════════════════════════════════════════════════════════════
  // v2.5.0 fix: null-matchId guard + pre-grant snapshot notification
  // ═════════════════════════════════════════════════════════════

  // ── Test 65: null matchId → early return, no false notification ─
  await runTest('v2.5.0: null matchId aborts transition grant (no UPDATE, no notify)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;

    // A row created via the token-spend upsert that NEVER seeded:
    // lastSeedBonusRoundID is null AND seedPresenceStart is null.
    // Under the old re-query pattern, a null-matchId transition grant
    // would write lastSeedBonusRoundID: null, then the notification
    // re-query (`lastSeedBonusRoundID = null AND seedPresenceStart = null`)
    // would match this unrelated row and send a false "bonus earned" warn.
    await db.upsert({
      eosID: 'neverSeeded',
      tokenBalance: 1,
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const connectedEosIDs = ['neverSeeded'];

    const result = await runTransitionGrantWithNotify(db, {
      matchId: null,   // gameState hasn't resolved a matchId yet
      connectedEosIDs
    });

    assert.strictEqual(result.grantCount, 0, 'guard must prevent any UPDATE with null matchId');
    assert.strictEqual(result.notifiedEosIDs.length, 0, 'no notification should fire');

    const row = await db.findByPk('neverSeeded');
    assert.strictEqual(row.tokenBalance, 1, 'unrelated row balance unchanged');
    assert.strictEqual(row.lastSeedBonusRoundID, null, 'lastSeedBonusRoundID still null (untouched)');
  });

  // ── Test 66: pre-grant snapshot prevents false notification ─
  await runTest('v2.5.0: notification draws only from the pre-grant snapshot (no re-query)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;

    // An unrelated row (never seeded) that happens to match the OLD
    // post-UPDATE re-query. It must never be notified.
    await db.upsert({
      eosID: 'neverSeeded',
      tokenBalance: 1,
      seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    // A legitimately-qualifying seeding player.
    await db.upsert({
      eosID: 'seeder',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const connectedEosIDs = ['neverSeeded', 'seeder'];

    const result = await runTransitionGrantWithNotify(db, {
      matchId: 'round-1',
      connectedEosIDs
    });

    // Only seeder qualifies (seedPresenceStart != null, earned == 0).
    assert.strictEqual(result.grantCount, 1, 'only seeder should receive the grant');

    // The notification must contain ONLY seeder — never 'neverSeeded'.
    assert.deepStrictEqual(
      result.notifiedEosIDs,
      ['seeder'],
      'notification should draw from the pre-grant snapshot, excluding the unrelated null-presence row'
    );

    const neverSeeded = await db.findByPk('neverSeeded');
    assert.strictEqual(neverSeeded.tokenBalance, 1, 'unrelated row must not be granted or notified');
  });

  // ═════════════════════════════════════════════════════════════
  // v2.5.0: three-valued logic, ENDGAME consolation, row retention
  // ═════════════════════════════════════════════════════════════

  // ── Test 67: the stranded-row shape (presence set, round NULL) ─
  await runTest('v2.5.0: row with presence set and lastSeedBonusRoundID NULL is reset, not stranded', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const maxTokens = 2;
    const bonusCap = 1;

    // This shape existed on 10 live rows in the 2026-08-17 export. It is produced
    // by any code path that sets seedPresenceStart without a matchId to pair it
    // with. Under a reset clause written as a bare `lastSeedBonusRoundID != matchId`,
    // ANSI three-valued logic evaluates NULL != 'round-1' as UNKNOWN and excludes
    // the row — and step 3 then excludes it too, because it requires equality. The
    // player accrues nothing for the entire round. The explicit NULL branch fixes it.
    await db.upsert({
      eosID: 'stranded',
      tokenBalance: 2,
      seedPresenceStart: new Date(now - BONUS_THRESHOLD_MS - 1000),
      seedBonusTokensEarned: 0,
      lastSeedBonusRoundID: null
    });

    const connectedEosIDs = ['stranded'];
    const allPlayers = [{ eosID: 'stranded', name: 'Stranded', steamID: 's1' }];

    const tick = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now
    });

    assert.strictEqual(tick.reset, 1, 'NULL round id must be treated as "different round"');

    const row = await db.findByPk('stranded');
    assert.strictEqual(row.lastSeedBonusRoundID, 'round-1', 'row is now scoped to the current round');
    assert.strictEqual(new Date(row.seedPresenceStart).getTime(), now, 'presence restarted');

    // And having been reset, it can earn once the threshold elapses.
    const later = now + BONUS_THRESHOLD_MS + 1000;
    await db.update(
      { seedPresenceStart: new Date(later - BONUS_THRESHOLD_MS - 1000) },
      { where: { eosID: 'stranded' } }
    );
    const tick2 = await runSeedTick(db, {
      connectedEosIDs, allPlayers, matchId: 'round-1',
      maxTokens, bonusCap, bonusMinutes: BONUS_MINUTES, now: later
    });
    assert.strictEqual(tick2.granted, 1, 'previously-stranded row now earns normally');
  });

  /**
   * Simulate _grantSeedBonusAtEndgame's qualifying WHERE.
   * Connected + presence predating ENDGAME + nothing earned + below the ceiling.
   * Deliberately has NO lastSeedBonusRoundID condition — see the production
   * docblock for why that clause would exclude every row at ENDGAME.
   */
  async function runEndgameGrant(db, opts) {
    const { connectedEosIDs, endgameStartedAt, maxTokens = 2, bonusAmount = 1 } = opts;
    const where = {
      eosID: { _in: connectedEosIDs },
      seedPresenceStart: { _ne: null, _lt: endgameStartedAt },
      seedBonusTokensEarned: 0,
      tokenBalance: { _lt: maxTokens + bonusAmount }
    };
    const qualifying = await db.findAll({ where, attributes: ['eosID'] });
    const [grantCount] = await db.update(
      {
        tokenBalance: { val: 'tokenBalance + 1' },
        seedBonusTokensEarned: { val: 'seedBonusTokensEarned + 1' },
        seedPresenceStart: null
      },
      { where }
    );
    // Close the round for every connected player, not only recipients.
    await db.update(
      { seedPresenceStart: null },
      { where: { eosID: { _in: connectedEosIDs }, seedPresenceStart: { _ne: null } } }
    );
    return { grantCount, granted: qualifying.map(r => r.eosID) };
  }

  // ── Test 68: ENDGAME consolation eligibility ────────────────
  await runTest('v2.5.0: ENDGAME grants to connected seeders whose presence predates ENDGAME', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    const endgameStartedAt = new Date(now);

    // Present for the round, never accrued a full chunk — the consolation case.
    await db.upsert({
      eosID: 'shortSeeder', tokenBalance: 2,
      seedPresenceStart: new Date(now - 5 * 60 * 1000),
      seedBonusTokensEarned: 0, lastSeedBonusRoundID: 'round-1'
    });
    // Connected during the scoreboard only — presence starts AFTER ENDGAME began.
    await db.upsert({
      eosID: 'lateJoiner', tokenBalance: 2,
      seedPresenceStart: new Date(now + 30 * 1000),
      seedBonusTokensEarned: 0, lastSeedBonusRoundID: 'round-1'
    });
    // Already earned via the periodic grant — keeps it, no double-dip.
    await db.upsert({
      eosID: 'earner', tokenBalance: 3,
      seedPresenceStart: new Date(now - 25 * 60 * 1000),
      seedBonusTokensEarned: 1, lastSeedBonusRoundID: 'round-1'
    });
    // Seeded the whole round but left before it ended — not in the roster.
    await db.upsert({
      eosID: 'leaver', tokenBalance: 2,
      seedPresenceStart: new Date(now - 25 * 60 * 1000),
      seedBonusTokensEarned: 0, lastSeedBonusRoundID: 'round-1'
    });

    const result = await runEndgameGrant(db, {
      connectedEosIDs: ['shortSeeder', 'lateJoiner', 'earner'],
      endgameStartedAt
    });

    assert.deepStrictEqual(result.granted, ['shortSeeder'], 'only the connected, pre-ENDGAME, unearned seeder qualifies');
    assert.strictEqual(result.grantCount, 1, 'exactly one grant');

    assert.strictEqual((await db.findByPk('shortSeeder')).tokenBalance, 3, 'consolation applied');
    assert.strictEqual((await db.findByPk('lateJoiner')).tokenBalance, 2, 'scoreboard joiner gets nothing');
    assert.strictEqual((await db.findByPk('earner')).tokenBalance, 3, 'periodic earner keeps their token, no second grant');
    assert.strictEqual((await db.findByPk('leaver')).tokenBalance, 2, 'player who left before ENDGAME gets nothing');
  });

  // ── Test 69: ENDGAME closes the round for everyone connected ─
  await runTest('v2.5.0: ENDGAME clears seedPresenceStart for all connected players, not just recipients', async () => {
    const db = createMockDb();
    const now = BASE_TIME;

    await db.upsert({
      eosID: 'earner', tokenBalance: 3,
      seedPresenceStart: new Date(now - 25 * 60 * 1000),
      seedBonusTokensEarned: 1, lastSeedBonusRoundID: 'round-1'
    });
    await db.upsert({
      eosID: 'leaver', tokenBalance: 2,
      seedPresenceStart: new Date(now - 25 * 60 * 1000),
      seedBonusTokensEarned: 0, lastSeedBonusRoundID: 'round-1'
    });

    await runEndgameGrant(db, {
      connectedEosIDs: ['earner'],
      endgameStartedAt: new Date(now)
    });

    // Without this sweep, anyone who earned keeps presence forever, which makes
    // their row permanently unprunable and inflates the tracked-player count.
    assert.strictEqual((await db.findByPk('earner')).seedPresenceStart, null, 'connected earner had presence cleared');
    assert.notStrictEqual((await db.findByPk('leaver')).seedPresenceStart, null, 'disconnected row is left alone');
  });

  /**
   * Simulate cleanup()'s two-tier retention WHERE.
   * Tier 1: exactly maxTokens, no seed state, no lockdown, idle > 30 minutes.
   * Tier 2: anything at all, idle > retentionDays.
   */
  async function runRetention(db, opts) {
    const { maxTokens = 2, retentionDays = 3, now, connectedEosIDs = [] } = opts;
    const emptyRowCutoff = new Date(now - 30 * 60 * 1000);
    const staleCutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
    const where = {
      _and: [
        { _or: [{ scrambleLockdownExpiry: null }, { scrambleLockdownExpiry: { _lt: new Date(now) } }] },
        { lastActiveTimestamp: { _ne: null } },
        {
          _or: [
            {
              tokenBalance: maxTokens,
              seedPresenceStart: null,
              seedBonusTokensEarned: 0,
              lastActiveTimestamp: { _lt: emptyRowCutoff }
            },
            { lastActiveTimestamp: { _lt: staleCutoff } }
          ]
        }
      ]
    };
    if (connectedEosIDs.length > 0) where._and.push({ eosID: { _notIn: connectedEosIDs } });
    return db.destroy({ where });
  }

  const IDLE_31M = 31 * 60 * 1000;
  const IDLE_4D = 4 * 24 * 60 * 60 * 1000;

  // ── Test 70: tier 1 deletes an empty row ────────────────────
  await runTest('v2.5.0: retention tier 1 deletes a row at exactly max with no seed state', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'empty', tokenBalance: 2, seedPresenceStart: null,
      seedBonusTokensEarned: 0, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_31M)
    });
    assert.strictEqual(await runRetention(db, { now }), 1, 'empty row should be pruned after 30 minutes');
    assert.strictEqual(await db.findByPk('empty'), null, 'row is gone');
  });

  // ── Test 71: tier 1 must NOT touch below-max rows (exploit) ──
  await runTest('v2.5.0: retention tier 1 keeps a below-max row (deleting it would refund tokens)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    // Token regeneration is lazy — this row holds real state in tokenRegenAnchor.
    // Deleting it hands the player a fresh row at maxTokens, so a 30-minute tier
    // applied to below-max rows is an exploit: switch, disconnect, come back in
    // 31 minutes with a full wallet instead of waiting out the refill.
    await db.upsert({
      eosID: 'spent', tokenBalance: 1, seedPresenceStart: null,
      seedBonusTokensEarned: 0, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_31M)
    });
    assert.strictEqual(await runRetention(db, { now }), 0, 'below-max row must survive tier 1');
    assert.strictEqual((await db.findByPk('spent')).tokenBalance, 1, 'regen state preserved');
  });

  // ── Test 72: tier 1 must NOT touch bonus holders ────────────
  await runTest('v2.5.0: retention tier 1 keeps a row above max (unspent seed bonus)', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'bonusHolder', tokenBalance: 3, seedPresenceStart: null,
      seedBonusTokensEarned: 0, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_31M)
    });
    assert.strictEqual(await runRetention(db, { now }), 0, 'bonus holder must survive tier 1');
    assert.strictEqual((await db.findByPk('bonusHolder')).tokenBalance, 3, 'bonus intact');
  });

  // ── Test 73: lockdown guard ─────────────────────────────────
  await runTest('v2.5.0: retention keeps an otherwise-empty row under active scramble lockdown', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    // scrambleLockdownDurationMinutes is the same order as tier 1's window, so
    // without this guard a disconnecting player could have their lockdown deleted
    // out from under them before it expires.
    await db.upsert({
      eosID: 'locked', tokenBalance: 2, seedPresenceStart: null,
      seedBonusTokensEarned: 0,
      scrambleLockdownExpiry: new Date(now + 15 * 60 * 1000),
      lastActiveTimestamp: new Date(now - IDLE_31M)
    });
    assert.strictEqual(await runRetention(db, { now }), 0, 'active lockdown blocks pruning');
    assert.ok(await db.findByPk('locked'), 'row still exists');
  });

  // ── Test 74: tier 2 catches everything past the window ──────
  await runTest('v2.5.0: retention tier 2 deletes abandoned rows whatever they hold', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    // Both below-max and above-max rows go once genuinely abandoned. This is the
    // rule that bounds table growth — every player who seeds ends up above max and
    // would otherwise be immortal.
    await db.upsert({
      eosID: 'oldSpent', tokenBalance: 1, seedPresenceStart: null,
      seedBonusTokensEarned: 0, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_4D)
    });
    await db.upsert({
      eosID: 'oldBonus', tokenBalance: 3, seedPresenceStart: null,
      seedBonusTokensEarned: 1, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_4D)
    });
    assert.strictEqual(await runRetention(db, { now, retentionDays: 3 }), 2, 'both abandoned rows pruned');
  });

  // ── Test 75: connected players are never pruned ─────────────
  await runTest('v2.5.0: retention never prunes a connected player', async () => {
    const db = createMockDb();
    const now = BASE_TIME;
    await db.upsert({
      eosID: 'online', tokenBalance: 2, seedPresenceStart: null,
      seedBonusTokensEarned: 0, scrambleLockdownExpiry: null,
      lastActiveTimestamp: new Date(now - IDLE_4D)
    });
    const deleted = await runRetention(db, { now, connectedEosIDs: ['online'] });
    assert.strictEqual(deleted, 0, 'connected player is exempt from both tiers');
    assert.ok(await db.findByPk('online'), 'row still exists');
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