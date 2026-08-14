#!/usr/bin/env bash
# PostToolUse hook (Edit|Write|MultiEdit): re-run the acceptance checks whose
# file globs match the edited file. Exit 2 blocks and feeds the failing
# output back to the model. Logic lives in gate-lib.mjs (zero-dependency).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/gate-lib.mjs" post-tool
