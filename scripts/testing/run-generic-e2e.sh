#!/usr/bin/env bash
set -euo pipefail

mode="${1:-full}"
case "$mode" in
  full|smoke) ;;
  *)
    printf 'Usage: %s [full|smoke]\n' "$0" >&2
    exit 2
    ;;
esac

# This lane is intentionally self-contained and zero-spend. Explicit empty
# values prevent dotenv from re-arming credentials in the Next.js child.
operator_home="$HOME"
firebase_emulators_path="${FIREBASE_EMULATORS_PATH:-${operator_home}/.cache/firebase/emulators}"
if [[ ! -d "$firebase_emulators_path" || -L "$firebase_emulators_path" ]]; then
  printf 'Generic E2E requires an existing, non-symlink Firebase emulator cache: %s\n' \
    "$firebase_emulators_path" >&2
  exit 1
fi
firebase_emulators_path="$(cd "$firebase_emulators_path" && pwd -P)"
playwright_browsers_path="${PLAYWRIGHT_BROWSERS_PATH:-}"
if [[ -z "$playwright_browsers_path" ]]; then
  for candidate in \
    "${operator_home}/Library/Caches/ms-playwright" \
    "${operator_home}/.cache/ms-playwright"; do
    if [[ -d "$candidate" && ! -L "$candidate" ]]; then
      playwright_browsers_path="$candidate"
      break
    fi
  done
fi
if [[ -z "$playwright_browsers_path" || ! -d "$playwright_browsers_path" || -L "$playwright_browsers_path" ]]; then
  printf 'Generic E2E requires an installed, non-symlink Playwright browser cache.\n' >&2
  exit 1
fi
playwright_browsers_path="$(cd "$playwright_browsers_path" && pwd -P)"
export FIREBASE_EMULATORS_PATH="$firebase_emulators_path"
export PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers_path"
export GENERIC_E2E_MODE="$mode"

exec node node_modules/tsx/dist/cli.mjs scripts/testing/run-generic-e2e-supervisor.ts
