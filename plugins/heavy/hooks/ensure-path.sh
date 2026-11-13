#!/bin/sh
# Session-start checks. Claude Code puts this plugin's bin/ on the Bash tool's PATH
# by itself, so a link is only needed for use outside it, and most people have none.
#
# Says something only when it needs to:
# - heavy needs node 20 or later, and without it nothing is throttled.
# - A link made by /heavy:install points into a version-numbered directory, so a
#   plugin update leaves it on the previous release. Nothing errors when that
#   happens, you just silently keep running old code, so re-point it here.
#
# Only a symlink into this plugin's cache is ever rewritten. A real file, or a
# symlink to anywhere else, is somebody else's and is left alone.

wrapper="$CLAUDE_PLUGIN_ROOT/bin/heavy"
[ -x "$wrapper" ] || exit 0

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
if [ -z "$major" ]; then
  printf 'The heavy plugin needs node, which is not on PATH, so nothing is being throttled.\n'
elif [ "$major" -lt 20 ]; then
  printf 'The heavy plugin needs node 20 or later and found node %s, so it will not work.\n' "$major"
fi

# Only an installed copy may take the link over. A session started with
# --plugin-dir on a checkout would otherwise point your terminal at that checkout.
case "$wrapper" in
  */plugins/cache/*/heavy/*/bin/heavy) ;;
  *) exit 0 ;;
esac

# Look where the installer links, rather than asking PATH: once the old version is
# cleaned up the link dangles, and `command -v` can no longer see it.
for link in "$HOME/.local/bin/heavy" "$HOME/bin/heavy"; do
  [ -L "$link" ] || continue
  target=$(readlink "$link")
  [ "$target" = "$wrapper" ] && continue
  case "$target" in
    */plugins/cache/*/heavy/*/bin/heavy)
      ln -sf "$wrapper" "$link"
      printf 'heavy: re-pointed %s at the installed version (%s)\n' "$link" "$wrapper"
      ;;
  esac
done
