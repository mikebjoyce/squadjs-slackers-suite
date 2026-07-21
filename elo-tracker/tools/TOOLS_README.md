# Tools

Standalone Node.js scripts for data analysis and manipulation.

These are **not part of the plugin** and are **not maintained** alongside it. They were written for one-off use during development — calibrating parameters, rebuilding ratings from match logs, merging log files, and analysing rating spread. They may be out of date, make assumptions about file paths or data shapes, and are provided as-is.

No support is provided. Use at your own risk.

---

## Scripts

**`analyze-spread.js`**
Cross-references a DB backup with a JSONL match log. Bins games by team average mu spread and reports favoured-team win rate per bucket. Useful for checking whether mu differences actually predict outcomes.
```
node analyze-spread.js <backup.json> <matchlog.jsonl>
```

**`elo-calibrate.js`**
Grid searches TrueSkill BETA and TAU parameters against historical match data, minimising weighted log-loss with a variance penalty. Outputs top 10 parameter sets and prediction curves.
```
node elo-calibrate.js <matchlog.jsonl> <db-backup.json>
```

**`elo-clans-audit.js`**
Utility script that loads a database JSON and outputs a comprehensive text report mapping all players to their detected clan group. Used to manually verify the extraction and normalization rules.
```
node elo-clans-audit.js [path/to/db.json]
```

**`elo-inspect.js`**
Interactive CLI tool to query players, view local leaderboards, analyse spread distribution, and simulate Discord round-end embeds using data from a match log. Can accept a secondary backup file to automatically calculate and display rating changes.
```
node elo-inspect.js <rebuilt.json> [old-backup.json] [matchlog.jsonl]
```

**`elo-rebuild.js`**
Replays all recorded matches from scratch using the current TrueSkill formula. Outputs a restore-compatible JSON backup. Useful after formula corrections.
```
node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]
```

**`merge-match-logs.js`**
Merges two JSONL match log files, deduplicates by `matchId` (first file wins on conflict), and sorts chronologically.
```
node merge-match-logs.js <fileA.jsonl> <fileB.jsonl> [output.jsonl]
```
