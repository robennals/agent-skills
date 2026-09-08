#!/bin/sh
# The guard stands down until `heavy` is on PATH, so a freshly installed plugin
# does nothing at all. Say so once per session, with the command that fixes it.
if command -v heavy >/dev/null 2>&1; then
  exit 0
fi
printf 'The heavy plugin is installed but its wrapper is not on PATH yet, so nothing is throttled. Run: bash "%s/bin/install-heavy.sh"\n' "$CLAUDE_PLUGIN_ROOT"
