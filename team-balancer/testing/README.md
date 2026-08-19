# Testing

Standalone scripts for testing and validating TeamBalancer behaviour.

These are **not part of the plugin** and are **not maintained** alongside it. They were written during development and vary in their current state — some work standalone, some require a live SquadJS server environment, and some are deprecated. They are provided as-is with no support.

---

## Scripts

**`scrambler-test-runner.js`**
Stress-tests the Scrambler algorithm using mock data. Runs multiple scenarios (standard, all-locked, David vs Goliath) and reports balance outcomes and cohesion metrics. Standalone — no server required.
```
node scrambler-test-runner.js
```

**`test-cross-clan-squad-collision.js`**
Two regression checks around clans that share a squad, both wired into `scrambler-test-runner.js` — no separate command needed.
- `runCrossClanSquadDecompositionTest` — 30 randomized runs where a third clan spans two squads already claimed by other clans. Squads must stay atomic, and no player may appear in two of the reported virtual squads.
- `runAnchorFallbackTagTest` — deterministic: when a clan's members sit entirely inside an earlier clan's virtual squad, the merged unit must keep both tags and count every real clan member as a member rather than as someone pulled along.

**`embed-format-test.js`**
Standalone assertions for the Discord scramble report (`DiscordHelpers.createScrambleDetailsMessage`): one row per listed player, one block per virtual squad, no player listed twice, correct `◆`/`◇`/`⚓` markers, and no field over Discord's 1024-character limit. Add `--print` to dump sample embeds for eyeballing column alignment. Standalone — no server required.
```
node embed-format-test.js [--print]
```

**`mock-data-generator.js`**
Helper module used by `scrambler-test-runner.js`. Generates mock player and squad data with configurable team ratios, lock rates, and squad size distributions. Not a runnable script — imported by other test files.

**`historical-scramble-test.js`**
Replays historical match data from an EloTracker DB backup and JSONL match log through the Scrambler. Reports balance outcomes against real round snapshots. Requires EloTracker output files.
```
node historical-scramble-test.js <elodb.json> [merged.jsonl]
```

**`plugin-logic-test-runner.js`** — ⚠️ **currently does not run**
Tests win streak logic, dominant win detection, and scramble triggering using a mock SquadJS environment. Carried over from the standalone TeamBalancer repo and never updated for S³: its mock server has no `SlackersSquadServices` plugin, so the mount path fails the S³ discovery and version checks. It also cannot resolve `s3-plugin-base.js` from the source tree, since `install.cjs` only flattens that next to `team-balancer.js` in the assembled output. Fixing it needs an assembled tree plus a mock S³ exposing `version` and the service getters.
```
node plugin-logic-test-runner.js
```

**`elo-integration-test.js`**
Tests ELO-weighted scramble behaviour against a constructed scenario (pro stack vs average team). Requires a live SquadJS environment for Logger — will error if run standalone without mocking Logger first.
```
node elo-integration-test.js
```

---

> **Note:** Some of these scripts use relative imports that assume a specific directory layout within a SquadJS installation. Running them outside that context will require path adjustments.
