# heavy

A machine-wide throttle for expensive commands, for people running several
coding agents on one machine.

Without it, parallel sessions all start the test suite at once and the machine
hangs hard enough to need a reboot. `heavy` serialises the expensive parts.

## Install

```
/plugin marketplace add robennals/agent-skills
/plugin install heavy@robennals-agent-skills
/heavy:install
```

The last step symlinks the wrapper into `~/.local/bin` (or `~/bin`), because a
plugin cannot change your PATH. Until it runs, the guard hook stands down and
nothing is throttled — installing this plugin never blocks a command before you
have the wrapper that unblocks it.

The symlink points into the installed plugin's version directory, so a plugin
update leaves it dangling. Nothing breaks quietly when that happens: the guard
hook stands down, and the session notice tells you to run `/heavy:install`
again.

## Use

```sh
heavy run   -- npm test          # finite and CPU-heavy: one at a time, machine-wide
heavy serve -- npm run dev       # long-lived: at most two at once
heavy status                     # who holds the locks, who is queued
```

- **`run` is a mutex of one.** Jobs wait in a FIFO queue.
- **`serve` is a pool of two.** Slots are held until the process exits, so
  servers can't accumulate, but they never block anyone's tests.
- **It waits by default**, 30 minutes. `--timeout 0` gives up immediately
  instead and exits 75, so a caller can tell "machine was busy" from "command
  failed".

Pass the command as an argv (`-- npm test`) or, when it needs shell syntax, as
one quoted string (`-- 'cd app && npm test | tail'`).

## What the guard blocks

A `PreToolUse` hook inspects every Bash command, splits it on shell separators,
and denies any segment that looks expensive — package-manager scripts
(`npm test`, `pnpm run typecheck`), runners (`npx playwright test`), and bare
binaries (`tsc`, `vitest`, `cargo test`, `docker compose up`, `mprocs`) — with
a message naming the wrapped form.

`--help` and `--version` invocations pass through, as do heredoc bodies:
writing a file that mentions `npm test` is not running it. `npm install` is
deliberately not covered — heavy in a large repo, but too routine to queue.

`HEAVY_GUARD=0` turns the hook off.

## Not for CI

Don't wire `heavy` into a GitHub Actions workflow. A runner has a box to itself
and nothing to contend with. The rule is about where a command runs, not which
command it is.

## Notes

Developed and tested on macOS. The lock itself is portable; the memory-pressure
wait relies on a macOS `sysctl` and goes inert elsewhere.

The guard hook only covers Claude Code. Agents on other harnesses get no
enforcement, so state the rule in your `AGENTS.md` too if you run those.

Internals, and how to widen or narrow what counts as expensive:
[skills/heavy/references/internals.md](skills/heavy/references/internals.md).

```sh
node --test test/heavy.test.js
```

## License

MIT
