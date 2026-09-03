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
├── test-dialect-literals.js   # Mock/production agreement on SQL literals
├── test-scramble-lockdown.js  # onScrambleExecuted's real write path (real DB)
├── test-admin-mutations.js    # Admin wipe/clear/regen write paths (real DB)
└── test-seed-token-lifecycle.js  # Four historical seed-bonus failures (real DB)
```

Most of these are **pure-logic unit tests**: no Docker, no live SquadJS server, no RCON, no Discord connection required, run with plain `node` and Node's built-in `assert` module. Three files are the exception — `test-scramble-lockdown.js`, `test-admin-mutations.js`, and `test-seed-token-lifecycle.js` build a throwaway flattened assembly (mirroring what `install.cjs` produces) and construct a real `Switch` instance against a real SQLite DB, with `test-admin-mutations.js` and `test-seed-token-lifecycle.js` also running their MySQL cases when the shared Docker test-MySQL container (`s3-test-mysql`, 127.0.0.1:3307) is reachable. Those exist because the mock harness models the database in JavaScript, which cannot reject a write for want of a DROP/ALTER grant and does not implement SQL three-valued logic — see [S3_DEVELOPER_GUIDE.md §11.4](../../s3/S3_DEVELOPER_GUIDE.md#114--testing-raw-sql-mocks-are-not-enough) for why that gap matters and how the skip-vs-pass counters are kept honest. When MySQL is unreachable those cases report as SKIPPED, not passed — read the skip count.

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
| Scramble lockdown (real DB) | 11 | `onScrambleExecuted` write path: `lastActiveTimestamp` on new/existing rows, queued-player exemption, EloDiff scrambles write no rows and still clear the queue / arm remediation |
| Admin mutations (real DB, SQLite+MySQL) | 45 | `adminWipeAll`/`clearall` as real DML including a MySQL user with no DROP grant, admin failures propagating instead of being swallowed by `_withDb()`, seed-token confiscation, NULL-vs-`< cap` three-valued logic, regen write-back |
| Seed token lifecycle (real DB, SQLite+MySQL) | 24 | The four historical seed-bonus failure modes: no grant at threshold, per-round counter not resetting (vs. the wallet-ceiling case it must not be confused with), duplicate warning spam, and players never draining from the DB after leaving |

**Total: 178 tests** (`node switch/testing/run-all-tests.js`'s own aggregate — rerun it rather than trusting this number as time passes). Requires `sequelize` on the module path (for `test-dialect-literals.js` and the three real-DB suites); the real-DB suites also need `s3-test-mysql` (127.0.0.1:3307) reachable for their MySQL cases, which otherwise report as skipped rather than passed. Everything else is Node.js stdlib.

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
node switch/testing/test-scramble-lockdown.js
node switch/testing/test-admin-mutations.js
node switch/testing/test-seed-token-lifecycle.js
node switch/testing/test-round-stats.js
```

### Run one suite at a time

**Do not run this runner concurrently with `s3/testing/run-all-tests.js`.**

`s3/testing/test-i18n.js` regenerates `s3/locale-templates/` — a fixed,
tracked directory, not a temporary one — and reads the results back. Two
runners doing that at once read each other's half-written output, and
`test-i18n.js` fails with nothing wrong in the code. Run them one after the
other and it passes. If you get exactly one failure and it is `test-i18n.js`,
check this before looking at the diff.

Two side effects of a normal run, both expected:

- `s3/locale-templates/*` comes back modified. That is the generator doing its
  job, not a stray edit.
- MySQL and Postgres cases report as **SKIPPED** when those engines are not
  running. Read the skip count in the summary — a skip is not a pass. To run
  them:

  ```bash
  docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
    -p 3307:3306 mysql:8
  docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
    -p 5433:5432 postgres:16-alpine
  ```

## What's NOT Tested (Remains Manual QA)

- **Full integration** requiring a live SquadJS server, RCON, or Discord — these are manual QA
- **Queue stability gate / pair trading logic** — unchanged by the token system

  Note that the queue paths are close to unreachable in manual QA too: a queue
  only forms when the teams are full and unbalanced, which is not something a
  maintainer can conjure on a test box. Every round-stat event is therefore
  logged as it is recorded, in one machine-readable shape, so a real round can
  be reconstructed afterwards from the server log:

  ```bash
  grep -o '\[RoundStat\] .*' squadjs.log
  # [RoundStat] queueTeamTrades {"p1Name":"Alice","p2Name":"Bob",...}
  ```

  Strip the prefix and `JSON.parse` the rest. `test-round-stats.js` holds the
  log and the stored row to the same numbers, and fails if any counter is ever
  recorded without a line.
- **Stats scraper regex parsing** — unchanged
- **Round summary embed format** — unchanged
- **Broadcast timers and join-warn scheduling** — unchanged
- **Handshake API with SmartAssign** — unchanged