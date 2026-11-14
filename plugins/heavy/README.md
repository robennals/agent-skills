# heavy

A machine-wide governor for expensive commands, for people running several coding
agents on one machine.

Without it, parallel sessions all start the test suite at once and the machine
hangs hard enough to need a reboot. `heavy` runs as many jobs at once as the
machine can actually take: it learns that number from CPU, memory and swap, and
stops jobs if the machine gets overwhelmed.

## Install

In Claude Code:

```
/plugin marketplace add robennals/agent-skills
/plugin install heavy@robennals-agent-skills
```

That's all: agents get the `heavy` command, a skill explaining it, and a guard that
blocks unwrapped expensive commands. It needs node 20 or later. Without node, the
guard stands down and you are told at session start, so your commands keep working.

- **For your own terminal:** run `/heavy:install` to link `heavy` into `~/.local/bin`
  or `~/bin`. Agents don't need this. The link is re-pointed for you when the plugin
  updates, and a `heavy` that isn't this plugin's link is left alone.
- **For other coding agents:** they need the command on PATH and an instruction in
  your `AGENTS.md` to use it; only Claude Code gets the guard. Run `/heavy:install`
  once from Claude Code, or link `plugins/heavy/bin/heavy` from a clone of this repo.

## Use

```sh
heavy run   -- npm test          # finite and CPU-heavy
heavy serve -- npm run dev       # long-lived
heavy status                     # how the machine is doing, what runs, what waits and why
```

- **The limit is learned.** While the machine stays calm and jobs are queueing,
  more may run at once.
- **Overload is handled for you.** If the machine is overwhelmed, `heavy` stops the
  newest job, cuts the limit, and waits longer before each later raise. The job
  exits 76 and is safe to re-run.
- **There is nothing to tune or run in the background.** It needs no daemon, and it
  works inside a command sandbox, where most agent commands run.
- **It waits by default**, 30 minutes. `--timeout 0` gives up immediately instead
  and exits 75, so a caller can tell "machine was busy" from "command failed".

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

Developed and tested on macOS. Where memory can't be read, such as on Linux,
`heavy` falls back to one job of each kind at a time.

Internals, and how to widen or narrow what counts as expensive:
[skills/heavy/references/internals.md](skills/heavy/references/internals.md).

```sh
node --test test/heavy.test.js
```

## License

MIT
