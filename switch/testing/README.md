# Switch Plugin — Test Suite

## Intent

The switch plugin is the most user-facing plugin in the S³ suite — it's invoked dozens of times per round by players requesting team changes. Bugs here are immediately visible and frustrating. Despite this, the plugin historically had **zero tests**.

The v2.3.0 token bucket system (§3.1–3.3 of `switch-token-system-spec.md`) introduced non-trivial algorithmic complexity: lazy regeneration, anchor bookkeeping, the "never clamp downward" rule for seeding grants, and atomic UPDATE-based seed bonus grants. These are exactly the kind of algorithms that get reimplemented subtly wrong during maintenance, and the spec itself warns about the most common pitfall (§3.1: "Do not implement this as `tokenBalance = min(maxSwitchTokens, tokenBalance + wholeIntervals)`").

This test suite exists to:

1. **Verify correctness** of the core token algorithms under all edge cases
2. **Guarantee backward compatibility** — at `maxSwitchTokens == 1` the system must be behaviorally identical to the pre-token flat-cooldown gate (§3.6)
3. **Catch regressions** during future refactors — the mock harness makes the token system testable without a live SquadJS server
4. **Document intended behavior** — each test name is a sentence describing the expected behavior, making the suite itself a form of executable specification

## Test Architecture

```
switch/testing/
├── README.md                  # This file
├── mock-harness.js            # Shared mock infrastructure
├── run-all-tests.js           # Aggregator runner
├── test-token-bucket.js       # Core regen/spend algorithms (§3.1–3.3)
├── test-eligibility-check.js  # Eligibility gate logic (§3.2)
├── test-token-messaging.js    # Player-facing string gating (§3.6)
├── test-admin-clear.js        # Admin clear refill semantics (§3.4)
├── test-seed-bonus.js         # Stage 2 seed bonus grants (§4.1–4.4)
├── test-token-queue-integration.js  # Token spend at queue resolution (§3.3)
└── test-dialect-literals.js   # Mock/production agreement on SQL literals
```

All tests are **pure-logic unit tests**. No Docker, no live SquadJS server, no RCON, no Discord connection required. They run with plain `node` and use Node's built-in `assert` module.

> **The mock cannot model a database.** These tests validate WHERE clauses and
> field updates against a hand-written mock, which by construction knows nothing
> about identifier folding, collation, or `ESCAPE` parsing. The mock's increment
> parser once matched only a bare `tokenBalance + 1`, so when the token grants
> started emitting the quoted, Postgres-safe `` `tokenBalance` + 1 ``, every
> mocked grant would have reported success while applying nothing.
> `test-dialect-literals.js` exists to close that gap: it feeds the mock a
> literal built by a **real** `DBService`, so a shape change fails loudly here
> instead of drifting silently. Anything touching raw SQL also needs
> `s3/testing/test-dialect-portability.js`, which runs against real engines.

## Mock Harness

`mock-harness.js` provides three components:

### `MockClock`
A controllable clock for deterministic time-based testing. Replaces `Date.now()` so regen intervals are predictable:

```js
const clock = new MockClock(BASE_TIME);
clock.advance(ONE_HOUR_MS);  // advance by exactly 1 hour
clock.now();                  // returns BASE_TIME + ONE_HOUR_MS
```

### `createMockDb()`
An in-memory Map-based mock of Sequelize's `PlayerCooldowns` model. Supports `findByPk`, `upsert`, `update`, `create`, `findAll` with:
- Operator shorthands (`_ne`, `_lt`, `_lte`, `_gte`, `_gt`, `_eq`) for WHERE conditions
- `_or` / `_and` at top level for complex queries
- `{ val: 'column + N' }` shorthand for increment operations (simulating `Sequelize.literal`)
- Raw row access via `_getRaw(eosID)` and `_entries()`

### `createMockHarness(options, clock)`
Builds a mock Switch plugin instance with exact copies of the real `_regenTokens`, `_spendToken`, and `_checkSwitchEligibility` methods. The mock methods are **line-for-line copies** of the live plugin code at `switch/plugins/switch.js` — this is intentional. Testing the same logic that runs in production is the goal.

Key configuration options:
- `maxSwitchTokens` (default: 2) — token cap
- `switchCooldownHours` / `switchCooldownMinutes` — per-token refill interval
- `switchEnabledMinutes` — eligibility window duration (default: 10)
- `seedTokenBonusAmount` / `seedTokenBonusMinutes` — Stage 2 seed bonus config
- `timeLimitEnabled` (default: true) — whether time/token checks apply
- `isLiberalMode` (default: false) — Seed/Jensen mode bypass

## Writing Tests

Each test file follows this pattern:

```js
import { createMockHarness, createMockDb, MockClock, assert } from './mock-harness.js';

// Define a test
await runTest('Test name: describes expected behavior', async () => {
  const clock = new MockClock(BASE_TIME);
  const { plugin } = createMockHarness({ maxSwitchTokens: 2 }, clock);
  const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };

  clock.advance(ONE_HOUR_MS);
  plugin._regenTokens(row);

  assert.strictEqual(row.tokenBalance, 1);
  assert.strictEqual(new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS);
});
```

For seed bonus tests (which test the atomic UPDATE WHERE patterns), the test helpers `checkSeedBonusGrants()` and `grantSeedBonusOnTransition()` simulate the exact Sequelize queries the plugin uses, with the mock DB's `_or` / `_ne` / `_lte` / `_lt` operators.

## Coverage Summary

| Area | Tests | Key Validations |
|------|-------|-----------------|
| Regen algorithm | 8 | Elapsed intervals, room gating, cap branch, above-cap preservation, zero cooldown |
| Spend algorithm | 5 | Cap→below-cap transition, above-cap non-reset, below-cap unchanged, regen→spend sequence, floor at zero |
| Eligibility checks | 8 | Fresh player, existing tokens, zero-token denial (reason 'cooldown'), scramble lock override (independent gate), time window, liberal mode, time-limit-disabled, regen recovery |
| Messaging gating | 9 | `showTokenMessaging` boolean, legacy-vs-token denial strings, explain step count, check format, post-switch notice |
| Admin clear | 4 | Refill to max, anchor reset, scramble lock nulled, seed presence nulled |
| Seed presence | 3 | Set on seed-mode join, not set in live mode, preserved on rejoin |
| Periodic grants | 5 | Threshold met, multi-grant presence reset, per-round cap, cross-round eligibility, no double-grant |
| Transition grants | 3 | Consolation award, skip if already earned, null presence on round end |
| Stacking above cap | 1 | Balance exceeds maxSwitchTokens from multiple seed grants, not clamped by regen |
| Re-entrancy guard | 1 | Boolean guard prevents concurrent periodic+transition processing |
| Queue integration | 3 | Solo switch spend, pair trade double spend, regen-while-queued anchor correctness |
| Dialect-safe literals | 12 | Increment-literal parsing (bare / backtick / double-quote / negative), mock applies a real `DBService` literal per dialect, full seed-grant field set, `caseInsensitiveLikeOp()` selection |

**Total: 98 tests. Requires `sequelize` on the module path (for `test-dialect-literals.js`); everything else is Node.js stdlib.**

## Running Tests

```bash
# Run all tests
node switch/testing/run-all-tests.js

# Run individual test files
node switch/testing/test-token-bucket.js
node switch/testing/test-eligibility-check.js
node switch/testing/test-token-messaging.js
node switch/testing/test-admin-clear.js
node switch/testing/test-seed-bonus.js
node switch/testing/test-token-queue-integration.js
node switch/testing/test-dialect-literals.js
```

## What's NOT Tested (Remains Manual QA)

- **Full integration** requiring a live SquadJS server, RCON, or Discord — these are manual QA
- **Queue stability gate / pair trading logic** — unchanged by the token system
- **Scramble lockdown logic** — unchanged, tested only for the "overrides tokens" eligibility check
- **Stats scraper regex parsing** — unchanged
- **Round summary embed format** — unchanged
- **Broadcast timers and join-warn scheduling** — unchanged
- **Handshake API with SmartAssign** — unchanged