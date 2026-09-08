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

## How The Lock Works

State lives in `$HEAVY_DIR` (default `/tmp/claude/heavy`), so it clears on
reboot. Each class has numbered slot files created with `O_EXCL`; the winner of
that race holds the slot. Each slot names its holder's pid and process start
time, and a slot whose holder is gone is reclaimed by the next waiter — a crash
or a `SIGKILL` cannot wedge the queue. Waiters take timestamped tickets so the
oldest goes first and no session starves.

Where `ps` is unavailable (inside a command sandbox) the start time can't be
read and pid liveness is used alone. That is deliberately fail-closed: treating
an unverifiable holder as dead would silently disable the lock.

Before taking a `run` slot, `heavy` also waits out critical memory pressure
(`kern.memorystatus_vm_pressure_level` 4) and warns if pressure goes critical
mid-job. Under a command sandbox `sysctl` is denied and this check is inert.

## Environment

| Variable | Effect |
|---|---|
| `HEAVY_DIR` | Where slot state lives. Default `/tmp/claude/heavy`. |
| `HEAVY_TIMEOUT` | Default wait in seconds. Default 1800. |
| `HEAVY_SERVE_SLOTS` | Size of the `serve` pool. Default 2. |
| `HEAVY_GUARD` | `0`, `off`, or `false` disables the guard hook. |
| `BB_THREAD_ID` | Reported in the holder list, if set. |

Developed and tested on macOS. On Linux the memory-pressure wait is inert,
because `kern.memorystatus_vm_pressure_level` does not exist and the probe
falls back to "normal"; the rest is untested there.

## Tests

```sh
node --test test/heavy.test.js
```

No dependencies and no test framework — just the Node built-in runner. The
17 tests cover exit-code propagation, the quoted-string and env-prefix
argument forms, a second job waiting on the mutex, many concurrent jobs never
overlapping, the `serve` pool admitting exactly its capacity, reclaiming a dead
holder's slot, the `--timeout 0` exit code of 75, rejecting a malformed
`--timeout`, the holder list naming branches, releasing every lock at the end,
and the guard's classify, heredoc, and stand-down decisions.
