#!/usr/bin/env bash
#
# SquadJS Slacker's Suite — Install Script (Bash wrapper)
#
# Assembles selected plugins into a deployable `out/` folder matching
# SquadJS's expected `squad-server/` layout.
#
# Usage:
#   ./install.sh --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
#                [--clean] [--force]
#
# Run `./install.sh --help` for the full flag list. Every argument is passed
# through untouched, so this script's usage IS install.cjs's usage.
#
# ─── WHY THIS IS A WRAPPER AND NOT A SECOND IMPLEMENTATION ───────────────────
#
# It used to be a full parallel port of install.cjs, and the two drifted, which
# is the failure mode a hand-maintained mirror always eventually has. The
# divergence that forced this rewrite: install.cjs learned to namespace
# `testing/` files whose relative path is claimed by more than one plugin —
# s3, elo-tracker and switch each own a `testing/run-all-tests.js`, and all
# three flatten onto the same target path. install.cjs renames them
# (`run-all-tests-s3.js`) after proving nothing imports them by name; this
# script still treated the third one as a fatal collision, so
# `--plugin=all --with-testing` succeeded under Node and aborted under Bash.
# Same repo, same flags, different answer.
#
# Rather than port the clash detection, the entry-point import scan and the
# namespacing rules a second time — the subtle parts, and so the parts that
# drift — this delegates. There is exactly one implementation of the assembly
# rules now, and this file cannot fall behind it.
#
# Requiring Node costs nothing: every environment that can run these plugins is
# already running SquadJS, which is a Node application. A machine that cannot
# run install.cjs cannot run what install.cjs installs.
#
# The old port also silently required Bash 4 for `declare -A`, so it never
# worked on a stock macOS /bin/bash in the first place.

set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$MONOREPO_ROOT/install.cjs"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required — install.sh delegates to install.cjs." >&2
  echo "Install Node.js, or run the installer directly on a machine that has it." >&2
  exit 1
fi

if [[ ! -f "$INSTALLER" ]]; then
  echo "Error: install.cjs not found next to install.sh (looked in $MONOREPO_ROOT)." >&2
  exit 1
fi

exec node "$INSTALLER" "$@"
