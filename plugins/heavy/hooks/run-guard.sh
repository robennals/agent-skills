#!/bin/sh
# Runs the guard if it can. Hook input arrives on stdin and passes straight through.
#
# A hook that fails is reported on every Bash command, so a machine without node
# would be nagged constantly. Standing down keeps the commands working; the
# SessionStart hook says why nothing is being throttled.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/heavy-guard.js"
