#!/usr/bin/env bash
# Stop hook: refuse to end the session unless completed-phase artifacts
# exist, done-story checks pass, and STATUS.json carries a finished mission,
# a fresh QA report, or a fresh handoff. `.impulse/force-stop` (written by
# the supervisor when killing a session at a cap) bypasses the gate.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/gate-lib.mjs" stop
