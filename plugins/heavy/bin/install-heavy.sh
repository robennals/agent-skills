#!/bin/sh
# Add `heavy` to your terminal by symlinking it from this plugin.
#
# Agents in Claude Code don't need this: the plugin's bin/ is already on the Bash
# tool's PATH. It is for running `heavy` yourself, or from other tools.
set -e

here=$(cd "$(dirname "$0")" && pwd)
wrapper="$here/heavy"

if [ ! -x "$wrapper" ]; then
  echo "install-heavy: no executable wrapper at $wrapper" >&2
  exit 1
fi

# Prefer a directory already on PATH, so no shell config has to change.
target=""
for dir in "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in
    *":$dir:"*) target="$dir"; break ;;
  esac
done

# Nothing suitable on PATH: create ~/.local/bin and say what to add.
if [ -z "$target" ]; then
  target="$HOME/.local/bin"
  mkdir -p "$target"
  echo "note: $target is not on your PATH. Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

link="$target/heavy"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "install-heavy: $link exists and is not a symlink; move it aside first" >&2
  exit 1
fi

ln -sf "$wrapper" "$link"
echo "linked $link -> $wrapper"

if command -v heavy >/dev/null 2>&1; then
  echo "heavy is on PATH."
else
  echo "heavy is not on PATH yet in this shell; open a new one or fix PATH as above."
fi
