---
description: Add the heavy command to your own terminal, for running it outside Claude Code. Agents in Claude Code already have it, so this is optional.
disable-model-invocation: true
---

Run the installer that ships with this plugin:

```sh
sh "${CLAUDE_PLUGIN_ROOT}/bin/install-heavy.sh"
```

Then confirm it took effect from the user's own terminal:

```sh
heavy status
```

If `heavy` is still not found there, the installer printed the `export PATH=...`
line to add to the user's shell profile. Report that line to them rather than
editing their profile yourself.
