# Testing

Standalone scripts for testing and validating TeamBalancer behaviour.

Some of these are wired into `node testing/run-all-tests.js [--fast]` (the
plugin's entry point, also reachable via `node testing/run-all-tests.js
--plugin=team-balancer` at the repo root); others are excluded from that
runner for documented reasons (historical replays need a CLI data-file
argument; `mock-data-generator.js` is a fixture module, not a test). See
`run-all-tests.js`'s own header for the exact included/excluded list.

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

**`plugin-logic-test-runner.js`**
Streak tracking, dominant-win detection, scramble triggering, and config validation, against the real plugin loaded through a throwaway flattened assembly (mirroring what `install.cjs` produces) so `./s3-plugin-base.js` resolves. Wired into `run-all-tests.js`. The note that used to say this "does not run" was itself wrong by the time it was written — nothing here ever touched a live server; it failed on a plain `ERR_MODULE_NOT_FOUND` import, now fixed by the sandboxed assembly.
```
node plugin-logic-test-runner.js
```

**`test-team-balancer-plugin.js`**
Regression for the layer-mirror deletion: `gameModeCached`/`layerNameCached` must be fed only by `gameState.onLayerGameModeChange()`, never `server.currentLayer` (which reads `null` after a mid-round SquadJS restart). Loads the real plugin via the same sandboxed assembly. Wired into `run-all-tests.js`.
```
node test-team-balancer-plugin.js
```

**`test-tb-elo-scramble.js`**
Pins both directions of one rule: squad atomicity outranks ELO parity. A skill stack spread across several squads must be broken up; the same stack inside one squad must be left alone rather than decomposed. Runs the randomized scrambler across many trials since it has no seed parameter. **Replaces** the now-deleted `elo-integration-test.js`, which turned out (once its dead import was fixed) to assert something impossible by construction — see the file's own header for the full history. Wired into `run-all-tests.js`.
```
node test-tb-elo-scramble.js
```

**`test-elo-diff-scramble.js`**
Covers the fourth scramble trigger — the small, budget-capped mu-gap correction fired at round end — distinct from the three ticket-margin-driven triggers `plugin-logic-test-runner.js` covers: threshold logic, budget search, `scrambleType` plumbing through `initiateScramble`/`executeScramble`/`onRoundEnded`. Stubs the randomized scrambler for determinism. Wired into `run-all-tests.js`.
```
node test-elo-diff-scramble.js
```

**`historical-elo-backbone-test.js`**
Replays recorded match data through the TrueSkill rating pipeline: convergence, round-over-round stability, and top-15 backbone-ELO correctness. Requires an EloTracker DB export as a CLI argument, so it's excluded from `run-all-tests.js`.
```
node historical-elo-backbone-test.js <elodb.json>
```

---

> **Note:** Some of these scripts use relative imports that assume a specific directory layout within a SquadJS installation. Running them outside that context will require path adjustments.
