#!/bin/sh
# Seed the methodology template into an empty workspace volume on first
# start, then hand off to CMD (idle `sleep infinity`; sessions run via exec).
# Re-used volumes (pause/resume, iterate) are left untouched.
set -e
WORKSPACE="${WORKSPACE_PATH:-/workspace}"
if [ ! -d "$WORKSPACE/.claude" ]; then
  mkdir -p "$WORKSPACE/.claude"
  cp -R /opt/impulse/template/skills "$WORKSPACE/.claude/skills"
  cp -R /opt/impulse/template/hooks "$WORKSPACE/.claude/hooks"
  cp /opt/impulse/template/settings.json "$WORKSPACE/.claude/settings.json"
  cp /opt/impulse/template/workspace.gitignore "$WORKSPACE/.gitignore"
  chmod +x "$WORKSPACE/.claude/hooks/"*.sh
fi
exec "$@"
