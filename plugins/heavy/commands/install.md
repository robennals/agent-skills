---
description: Put the heavy wrapper on PATH, so the guard hook starts throttling expensive commands
---

Run the installer that ships with this plugin:

```sh
bash "${CLAUDE_PLUGIN_ROOT}/bin/install-heavy.sh"
```

Then confirm it took effect:

```sh
heavy status
```

If `heavy` is still not found, the installer printed the `export PATH=...` line
to add to the user's shell profile. Report that line to them rather than
editing their profile yourself.
