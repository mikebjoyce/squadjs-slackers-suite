# Contributing

Contributions are welcome. What follows is the set of repo conventions you can't
work out by reading the source. Everything else is in the
[S³ Developer Guide](s3/S3_DEVELOPER_GUIDE.md).

## Before you start

Open an issue, or comment on an existing one, before starting anything
substantial. Not for permission, but so the ground doesn't move under you.
`master` takes merges regularly, and a branch forked a fortnight ago can find
that most of the files it touches have shifted since.

## Plugin options must be declared

SquadJS's `BasePlugin` constructor builds `this.options` by iterating the
plugin's `optionsSpecification` and nothing else. A key that appears in
`config.json` but isn't declared there gets kept on `this.rawOptions`, which
nothing reads, so `this.options.yourOption` is `undefined` forever.

There's no warning and the plugin loads normally. If a new option isn't taking
effect, this is why.

## install.cjs flattens the tree

Each plugin's `plugins/` and `utils/` directories get copied and collapsed into
two directories in the installed layout. Three consequences:

A new top-level folder isn't part of that copy and never reaches an installed
server. Put files under an existing plugin's `utils/`.

Basenames are global once flattened. Namespace the filename (`s3-locale-pt.js`,
`tb-commands.js`) rather than relying on the directory to disambiguate, because
a name shared across two plugins gets renamed at the target.

A cross-plugin relative import that resolves in `out/` won't resolve in this
source tree, and the reverse. Reach other plugins through the instance you were
handed, not through `../`.

Run `node install.cjs --plugin=all` and look at `out/` to see the shape. Never
pass `--clean` at a live server's directory.

## Tests

```bash
node testing/run-all-tests.js            # every plugin
node testing/run-all-tests.js --fast     # skip the slow randomised sweeps
node testing/run-all-tests.js --plugin=s3
```

Run the plugin runners one at a time. Concurrent runs race over shared generated
files and produce failures that have nothing to do with your change.

A green run isn't sufficient for anything touching the database. The suites that
need a real engine skip themselves when it's unreachable, so a run with no MySQL
container reports all-pass having tested SQLite only. The
[README](README.md#testing) lists the containers to start and what the output
has to say.

New behaviour needs a test that fails without it. Check that by reverting your
fix and watching the test fail. A test that passes either way is worse than
none, because it reads as coverage.

## Localization

Read [`s3/LOCALIZATION.md`](s3/LOCALIZATION.md) before touching a catalogue or
adding a user-facing string. Two rules cover most of it. English is the source
of truth, and every other catalogue mirrors its keys and placeholders exactly.
The server log isn't translatable: `Logger.*`, `verbose()`, `stderrError()` and
`console.*` take English literals, never a catalogue key, and the suite fails
the build if a localized string reaches one of them.

Translations are welcome, partial ones included. Untranslated keys fall back to
English individually, so there's no need to finish before submitting.

## Pull requests

Run `node --check` on any file you edit, and the suites above, before pushing.

Keep unrelated reformatting out of the diff. Whitespace-only churn in files you
didn't otherwise change makes review much harder than it needs to be.

Commits keep their original authorship when a branch gets reworked before
landing. If a maintainer picks up your work and finishes it, it lands with your
commits intact.
