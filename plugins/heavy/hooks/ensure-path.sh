#!/bin/sh
# Keep `heavy` on PATH pointing at the plugin copy that is actually installed.
#
# The wrapper lives in a version-numbered directory, so a plugin update moves
# it and leaves any symlink behind pointing at the old release. Nothing errors
# when that happens — you just silently keep running the previous version. So
# re-point the link here, once per session, when it has drifted.
#
# This only ever rewrites a symlink that points into a plugin cache directory
# for this plugin. A real file, or a symlink to anywhere else, is somebody
# else's and is left alone with a message instead.

wrapper="$CLAUDE_PLUGIN_ROOT/bin/heavy"
[ -x "$wrapper" ] || exit 0

current=$(command -v heavy 2>/dev/null)

# Already correct: say nothing.
if [ -n "$current" ] && [ "$(cd "$(dirname "$current")" && pwd -P)/$(basename "$current")" = "$wrapper" ]; then
  exit 0
fi
if [ -n "$current" ] && [ -L "$current" ] && [ "$(readlink "$current")" = "$wrapper" ]; then
  exit 0
fi

# On PATH but not ours. Only adopt a link we recognise as a stale copy of
# this same plugin.
if [ -n "$current" ]; then
  target=$(readlink "$current" 2>/dev/null || echo '')
  case "$target" in
    */plugins/cache/*/heavy/*/bin/heavy)
      ln -sf "$wrapper" "$current"
      printf 'heavy: re-pointed %s at the installed version (%s)\n' "$current" "$wrapper"
      ;;
    *)
      printf 'heavy: %s is on PATH but is not this plugin, so it is being left alone. The wrapper shipped here is %s\n' "$current" "$wrapper"
      ;;
  esac
  exit 0
fi

# Not on PATH at all: the guard hook stands down, so nothing is throttled.
printf 'The heavy plugin is installed but its wrapper is not on PATH yet, so nothing is throttled. Run: bash "%s/bin/install-heavy.sh"\n' "$CLAUDE_PLUGIN_ROOT"
