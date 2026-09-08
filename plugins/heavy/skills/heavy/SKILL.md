---
name: heavy
description: Use before running any expensive command on a shared development machine - tests, typecheck, build, lint, E2E, or a dev server - so that only one CPU-heavy job and a bounded number of servers run at a time. Covers `heavy run`, `heavy serve`, `heavy status`, how to wait or give up, and what the PreToolUse guard blocks.
---

# Running Expensive Commands

Many agent sessions can work on one machine at once. Without coordination they
all decide to run the test suite at the same moment, and the machine hangs hard
enough to need a reboot. `heavy` is a wrapper that serialises the expensive
parts.

## Using It

```sh
heavy run   -- npm test          # CPU-heavy and finite: tests, typecheck, build, E2E, lint
heavy serve -- npm run dev       # long-lived and memory-heavy: dev servers, watchers
heavy status                     # who holds the locks, who is queued
```

- **`run` is a machine-wide mutex of one.** Your job waits in a FIFO queue
  until whoever is ahead of you finishes.
- **`serve` is a pool of two slots**, held until the process exits. Servers
  don't block anyone's tests — they just can't accumulate. If a task genuinely
  needs several servers at once, run them under a single
  `heavy serve -- mprocs ...` rather than taking a slot each.

Everything after `--` is the command, in either of two shapes:

```sh
heavy run -- npm test                          # an argv, spawned directly
heavy run -- 'cd app && npm test 2>&1 | tail'  # one quoted string, run via $SHELL
```

Use the quoted form whenever the command needs shell syntax. It has to be
quoted: your own shell splits on `&&` and `|` before `heavy` sees anything, so
an unquoted compound command would only ever reach the wrapper as its first
piece. A leading `KEY=value` env prefix works in either shape.

Wrapping only the expensive part is also fine, and is what the guard suggests:

```sh
cd plugins/code-review && heavy run -- npm test | tail -20
```

## Waiting Or Giving Up

`heavy` waits its turn by default, for up to 30 minutes. Waiting is the right
default: a command that aborts because the machine was busy just puts the
decision back on the caller, who usually needed the result anyway.

`--timeout SEC` bounds the wait, and `--timeout 0` means don't wait at all —
fail now if something else holds the lock. Either way it exits **75** having
run nothing, so a caller can tell "the machine was busy" from "the command
failed". `HEAVY_TIMEOUT` sets the default for a shell.

```sh
heavy run --timeout 0 -- npm test    # only if the machine is free right now
```

When it gives up, it names who is holding the slots — each holder's command,
git branch, session and directory — so a full `serve` pool is actionable
rather than a dead end. The branch is read from the holder's directory at that
moment, so it is current even for a server that has been up for hours:

```
heavy: the machine-wide 'serve' lock is busy
2 of 2 'serve' slots in use:
  npm run dev, branch e2e-verification-harness, thr_w6e4dmwrhy, 812s
    /Users/rob/worktrees/env_wnu78dgm48/lightcone-commons
  npm run dev, branch code-review-self-contained-panel, thr_6i6c4pivjr, 90s
    /Users/rob/repos/bb-plugins
ask the sessions on e2e-verification-harness and code-review-self-contained-panel
to stop, if that work is done
```

The same holder list appears in `heavy status` and in the periodic message
printed while a job waits. Ask your human to shut one of those servers down if
you need a slot.

For anything slow, start it in the background rather than shortening the
timeout. `heavy` may queue behind another session for minutes, which a tool's
own command timeout would otherwise cut short.

## Not In CI

`heavy` is for one shared machine. Don't add it to a GitHub Actions workflow or
any other CI config — a runner has a box to itself and nothing to contend with.

That is a statement about where the command runs, not about which commands
count: the test suite CI runs is exactly the kind of thing that needs wrapping
when you run it locally.

## While A Job Runs

Re-check memory pressure periodically:

```sh
sysctl kern.memorystatus_vm_pressure_level   # 1 normal, 2 warning, 4 critical
sysctl -n vm.swapusage
```

If pressure reaches 4 (what Activity Monitor shows as red), or swap is climbing
steeply, **kill the job** rather than letting it thrash. A typecheck you can
re-run costs minutes; a hung machine costs a reboot. Background jobs are the
main risk, since they keep running while you do something else — never leave
one unattended without checking back.

Don't use `uptime` or load average on macOS to judge this. It counts far more
than CPU-bound work and overstates how busy the machine is; the `sysctl`
commands above match what Activity Monitor shows.

## When The Guard Blocks You

A `PreToolUse` hook denies any Bash command that looks expensive and isn't
wrapped, naming the wrapped form to use instead. Take the suggestion. The
escape hatches, in order of preference:

- `heavy run --timeout 0 -- ...` — still throttled, but gives up instead of
  queueing.
- `HEAVY_GUARD=0` in the environment — turns the hook off entirely. For a
  human's own terminal, not for agents.

If `heavy` is not on PATH the hook allows everything, so a machine without the
wrapper is never wedged by the guard. Run
`bash "$CLAUDE_PLUGIN_ROOT/bin/install-heavy.sh"` to put it on PATH.

For exactly which commands are recognised, how the lock survives crashes, and
how to widen or narrow the patterns, read
[references/internals.md](references/internals.md).
