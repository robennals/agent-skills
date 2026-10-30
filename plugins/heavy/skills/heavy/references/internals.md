# heavy internals

## What The Guard Recognises

`hooks/heavy-guard.js` runs on every `Bash` tool call, splits the command on
shell separators, and denies any segment that looks expensive. It recognises:

- **package-manager scripts** — `npm test`, `pnpm run typecheck`, `yarn build`,
  `bun test`, for script names starting `test`, `build`, `dev`, `start`,
  `serve`, `preview`, `watch`, `lint`, `typecheck`, `check`, `e2e`, `ci`,
  `storybook`, `integration`
- **runners** — `npx playwright test`, `bunx vitest`
- **bare binaries** — `tsc`, `vitest`, `jest`, `mocha`, `playwright`,
  `cypress`, `eslint`, `next`, `vite`, `webpack`, `turbo`, `nx`, `storybook`,
  `gradle`, `mvn`, `pytest`, `tox`, `make`, `mprocs`
- **subcommands of mixed tools** — `cargo build|test|run|clippy|bench`,
  `go build|test|run`, `docker build|compose`

Scripts and binaries matching `dev`, `start`, `serve`, `preview`, `watch`, or
`storybook` are classified `serve` rather than `run`, since they are long-lived.

It deliberately passes through:

- anything carrying `--help`, `-h`, `--version`, `-v`, or `--list`
- heredoc bodies — writing a file that mentions `npm test` is not running it
- `npm install` / `npm ci`, which are heavy in a large repo but too routine to
  queue

Wrapper prefixes (`sudo`, `time`, `nohup`, `command`, `exec`) are stripped
before classifying, so `time npm test` is still caught.

To widen or narrow this, edit the pattern tables at the top of the hook.

The hook only covers Claude Code. Agents on other harnesses get no enforcement,
so state the rule in your `CLAUDE.md` / `AGENTS.md` as well if you run those.

## How The Limit Is Learned

`heavy` keeps one number, the **limit**: how many jobs, `run` and `serve` together,
may run at once. It starts at 2 and moves on evidence.

| What heavy sees | What it does |
|---|---|
| **Calm**, a job is waiting, and the limit is what is holding it back | Raises the limit by one, after enough calm time. Starts at 30s. |
| **Calm, nothing waiting** | Nothing. A quiet machine proves nothing about whether more would fit. |
| **Busy** | Starts nothing new beyond the one guaranteed job of each kind. The limit stays put. |
| **Overloaded** | Starts nothing. Stops one job, at most every 30s. Cuts the limit to half of what was running. Doubles the calm time each later raise needs, up to 10 minutes. |

After 30 minutes with no overload the calm time drops back to 30s. The limit itself
stays where it was and has to earn its way back up.

A job that starts also blocks the next start for 15s, while it shows its real load;
a job that finishes sooner releases that wait at once, so short jobs flow freely.

### What Counts As Busy Or Overloaded

| Signal | Busy | Overloaded |
|---|---|---|
| CPU in use | 70% | 98% for 2 minutes, with at least two jobs running |
| Memory free, from `memory_pressure -Q` | 30% | 15% for 6s |
| Swap traffic, from `vm_stat` | 20MB/s | 150MB/s for 6s |
| Pressure level, from `sysctl`, only outside a sandbox | 2 | 4 for 6s |
| A simple query taking over 5s | | for 6s |

`serve` jobs ignore the CPU column when deciding whether to start: servers mostly
sit idle. Load average is deliberately not used.

The thresholds are constants near the top of `bin/heavy`. They were set from one
machine's normal readings (14 cores, 48GB: CPU 11-45%, 51-54% free, no swap
traffic), not from a real hang, so the overloaded column is an estimate.
`$HEAVY_DIR/events.log` records every raise and every stop with its reason, which
is what to read when tuning them.

### Which Job Gets Stopped

The newest `run` job, since it has the least work to lose. Servers go only when no
`run` job is left, because a person or an E2E suite may be using one. The job gets
SIGTERM, then SIGKILL 5s later, and its whole process group goes with it. A job is
stopped even if it is the last one when memory is the problem, but never for CPU
alone. Nothing is restarted automatically: not every command is safe to repeat.

### Why There Is No Daemon

Most agent commands run in a command sandbox, which denies `sysctl`, `ps`, `top`,
`iostat`, and signalling other processes' jobs. `vm_stat`, `memory_pressure`, and
node's CPU counters still work, so every wrapper can measure the machine. Whichever
one finds the measurement over 3s old refreshes it for the others, under a small
lock, and each wrapper stops only its own job when told to. Nothing runs while no
job does, and there is nothing to install.

Where memory can't be read at all, such as on Linux, `heavy` falls back to one job
of each kind at a time rather than running blind.

## How The Slots Work

State lives in `$HEAVY_DIR` (default `/tmp/claude/heavy`), so it clears on reboot,
including the learned limit. `machine.json` holds the limit and latest measurement.
Each class has numbered slot files created with `O_EXCL`; the winner of that race
holds the slot. Each slot names its holder's pid and process start time, and a slot
whose holder is gone is reclaimed by the next waiter — a crash or a `SIGKILL` cannot
wedge the queue. Waiters take timestamped tickets so the oldest goes first and no
session starves.

Where `ps` is unavailable (inside a command sandbox) the start time can't be read
and pid liveness is used alone. That is deliberately fail-closed: treating an
unverifiable holder as dead would silently disable the limit.

## Environment

| Variable | Effect |
|---|---|
| `HEAVY_DIR` | Where the state lives. Default `/tmp/claude/heavy`. |
| `HEAVY_TIMEOUT` | Default wait in seconds. Default 1800. |
| `HEAVY_RUN_SLOTS` | Hard ceiling on `run` jobs, whatever is learned. Default half the CPU cores. Set to 1 for strictly one at a time. |
| `HEAVY_SERVE_SLOTS` | Hard ceiling on `serve` jobs. Default half the CPU cores. |
| `HEAVY_GUARD` | `0`, `off`, or `false` disables the guard hook. |
| `BB_THREAD_ID` | Reported in the holder list, if set. |
| `HEAVY_READINGS`, `HEAVY_TIME_SCALE` | For the tests: a file of scripted readings, and a multiplier on every interval. |

Developed and tested on macOS. On Linux the fallback above applies; the rest is
untested there.

## Tests

```sh
node --test test/heavy.test.js
```

No dependencies and no test framework — just the Node built-in runner. The tests
drive the real wrapper with scripted machine readings and faster timers, covering
parallel starts, raising the limit, holding jobs while busy, stopping the newest job
on overload, the remembered backoff, the order jobs are stopped in, the
one-at-a-time fallback, and the older exit-code, queueing, and guard behaviour.
