// node --test test/heavy.test.js
//
// Drives the real binaries the way they are actually invoked — the guard over
// stdin JSON, the wrapper as a subprocess — so the tests cover the contract
// rather than an exported copy of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const HEAVY = path.join(HERE, '..', 'bin', 'heavy')
const GUARD = path.join(HERE, '..', 'hooks', 'heavy-guard.js')

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-test-'))
const CALM = { cpu: 20, freePct: 50, swapMBps: 0, pressure: 1, stalled: false }

function writeReading(file, reading) {
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(reading))
  fs.renameSync(temporary, file)
}

// The tests feed the real control loop scripted readings instead of measuring this
// machine, and run its timers 50 times faster: sample 60ms, settle 300ms, first
// raise 600ms, overload counts after 120ms, stops at least 600ms apart.
function machineEnv(dir, extra = {}) {
  const readings = path.join(dir, 'readings.json')
  writeReading(readings, CALM)
  return { ...process.env, HEAVY_DIR: dir, HEAVY_READINGS: readings, HEAVY_TIME_SCALE: '0.02', ...extra }
}

// One job at a time unless a test asks otherwise, so the queueing tests below say
// the same thing whatever the limit has learned.
const heavyEnv = machineEnv(lockDir, { HEAVY_RUN_SLOTS: '1', HEAVY_SERVE_SLOTS: '2' })

// A throwaway machine, so a test can overload it without affecting the others.
function freshMachine(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-test-'))
  const env = machineEnv(dir, extra)
  return {
    dir,
    env,
    set: (reading) => writeReading(env.HEAVY_READINGS, { ...CALM, ...reading }),
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8')),
    start: (label, command, flags = []) =>
      spawn(process.execPath, [HEAVY, flags[0] ?? 'run', '--label', label, ...flags.slice(1), '--', command],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }),
    running: () => {
      const report = JSON.parse(execFileSync(process.execPath, [HEAVY, 'status', '--json'], { env, encoding: 'utf8' }))
      return [...report.run.holders, ...report.serve.holders].map((job) => job.label).sort()
    },
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

// Ends jobs through their own wrappers, which takes the job's process group too.
async function endJobs(jobs) {
  for (const { child } of jobs) child.kill('SIGTERM')
  await Promise.all(jobs.map(({ done }) => done))
}

async function until(condition, what) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return
    await sleep(25)
  }
  assert.fail(`never happened: ${what}`)
}

function askGuard(command, env = {}) {
  return execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    // The guard allows everything when no wrapper is installed, so the deny
    // cases need `heavy` reachable regardless of the caller's PATH.
    env: { ...process.env, PATH: `${HERE}${path.delimiter}${process.env.PATH}`, ...env },
  })
}

// null when allowed, otherwise the class the guard told the agent to use.
function guard(command, env = {}) {
  const out = askGuard(command, env)
  if (!out.trim()) return null
  const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason
  return reason.match(/heavy (run|serve) --/)[1]
}

function heavy(args) {
  return spawn(process.execPath, [HEAVY, ...args], { env: heavyEnv, stdio: ['ignore', 'pipe', 'pipe'] })
}

function finished(child) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })))
}

async function waitForServeHolders(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (status().serve.holders.length === count) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`serve never reached ${count} holders`)
}

function status() {
  return JSON.parse(execFileSync(process.execPath, [HEAVY, 'status', '--json'], { env: heavyEnv, encoding: 'utf8' }))
}

test('guard sorts commands into run, serve, or allowed', () => {
  const run = [
    'npm test', 'npm run test:unit', 'npm run typecheck', 'npm run build',
    'pnpm test', 'yarn build', 'npx tsc --noEmit', 'npx playwright test',
    'npm exec vitest', 'pnpm dlx playwright test',
    'tsc --noEmit', 'vitest run', 'eslint .', 'cargo test', 'go test ./...',
    'docker compose build', 'vite build', 'bb plugin build', 'make',
    'cd foo && npm test', 'npm test | tail -5', 'CI=1 npm test',
  ]
  const serve = [
    'npm run dev', 'npm run start', 'next dev', 'vite', 'mprocs',
    'docker compose up -d', 'bb plugin dev', 'vitest --watch',
  ]
  const allowed = [
    'npm run', 'git status', 'ls -la', 'cat package.json', 'cargo fmt',
    'bb status', 'npm test --help', 'echo "npm test"',
    'heavy run -- npm test', 'heavy serve -- npm run dev',
  ]
  for (const command of run) assert.equal(guard(command), 'run', command)
  for (const command of serve) assert.equal(guard(command), 'serve', command)
  for (const command of allowed) assert.equal(guard(command), null, command)
})

test('guard denies the unwrapped half of a partly wrapped command', () => {
  assert.equal(guard('heavy run -- npm test && npm run build'), 'run')
})

test('guard reads a heredoc body as data, not as commands', () => {
  assert.equal(guard("cat > f.sh <<'SH'\nnpm test\nSH\nls"), null)
  // The command around the heredoc is still inspected.
  assert.equal(guard("cat > f.sh <<'SH'\nhello\nSH\nnpm test"), 'run')
})

test('guard stands down when it cannot help', () => {
  assert.equal(guard('npm test', { HEAVY_GUARD: '0' }), null)
  // No wrapper on PATH: never wedge a machine that has nothing to wedge it with.
  // (node is resolved by absolute path, so emptying PATH hides only heavy.)
  assert.equal(execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  }).trim(), '')
})

test('guard ignores tools other than Bash', () => {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'npm test' } }),
    encoding: 'utf8',
  })
  assert.equal(out.trim(), '')
})

test('wrapper runs an argv and propagates its exit code', async () => {
  assert.equal((await finished(heavy(['run', '--', 'sh', '-c', 'exit 7']))).code, 7)
  const ok = await finished(heavy(['run', '--', 'echo', 'hello']))
  assert.equal(ok.stdout.trim(), 'hello')
})

test('wrapper runs a single quoted argument as shell syntax', async () => {
  const result = await finished(heavy(['run', '--', 'cd / && echo "in $(pwd)"']))
  assert.equal(result.stdout.trim(), 'in /')
})

test('wrapper applies a leading env prefix instead of running it as a binary', async () => {
  const result = await finished(heavy(['run', '--', 'CI=1', 'sh', '-c', 'echo "CI=$CI"']))
  assert.equal(result.stdout.trim(), 'CI=1')
})

test('a ceiling of one is a mutex: a second job waits for the first', async () => {
  const order = []
  const first = finished(heavy(['run', '--label', 'first', '--', 'sh', '-c', 'sleep 1']))
    .then(() => order.push('first'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const second = finished(heavy(['run', '--label', 'second', '--', 'true']))
    .then(() => order.push('second'))
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
})

// The direct question: can two jobs ever hold `run` at once? Each job brackets
// its work in a shared log, so any overlap shows up as two starts in a row.
// Launching them simultaneously is the point — it races the slot claim itself.
test('a ceiling of one never lets two jobs overlap, even when they all start at once', async () => {
  const log = path.join(lockDir, 'overlap.log')
  const jobs = [0, 1, 2, 3, 4].map((n) =>
    finished(heavy(['run', '--label', `job-${n}`, '--',
      `echo start-${n} >> ${log}; sleep 0.3; echo end-${n} >> ${log}`]))
  )
  for (const result of await Promise.all(jobs)) assert.equal(result.code, 0)

  const events = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(events.length, 10)
  for (let i = 0; i < events.length; i += 2) {
    const id = events[i].split('-')[1]
    assert.match(events[i], /^start-/, `expected a start at ${i}, got ${events[i]} — jobs overlapped`)
    assert.equal(events[i + 1], `end-${id}`, `job ${id} was interleaved with another`)
  }
})

test('serve admits up to its ceiling', async () => {
  const jobs = [0, 1].map(() => finished(heavy(['serve', '--', 'sh', '-c', 'sleep 1'])))
  await waitForServeHolders(2)
  await Promise.all(jobs)
  assert.equal(status().serve.holders.length, 0)
})

test('a full serve pool names the branches holding it', async () => {
  const repo = path.join(lockDir, 'branch-repo')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'feature-branch', repo])
  const holders = [0, 1].map(() =>
    finished(spawn(process.execPath, [HEAVY, 'serve', '--label', 'dev-server', '--', 'sh', '-c', 'sleep 2'],
      { env: heavyEnv, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })))
  await waitForServeHolders(2)

  const blocked = await finished(heavy(['serve', '--timeout', '0', '--', 'echo', 'should-not-run']))
  assert.equal(blocked.code, 75)
  assert.match(blocked.stderr, /2 of 2 'serve' slots are in use/)
  assert.match(blocked.stderr, /2 'serve' jobs running/)
  assert.match(blocked.stderr, /dev-server, branch feature-branch/)
  assert.match(blocked.stderr, /ask the thread on feature-branch to stop/)
  await Promise.all(holders)
})

test('a slot held by a dead process is reclaimed, not waited on forever', async () => {
  fs.mkdirSync(path.join(lockDir, 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(lockDir, 'run', 'slot-0.json'),
    JSON.stringify({ pid: 99998, psStart: 'never', label: 'ghost', startedAt: 0 })
  )
  const result = await finished(heavy(['run', '--timeout', '5', '--', 'echo', 'reclaimed']))
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'reclaimed')
})

test('waiting on a live holder times out without running the command', async () => {
  const holder = finished(heavy(['run', '--label', 'holder', '--', 'sh', '-c', 'sleep 3']))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const blocked = await finished(heavy(['run', '--timeout', '1', '--', 'echo', 'should-not-run']))
  assert.equal(blocked.code, 75)
  assert.equal(blocked.stdout.trim(), '')
  assert.match(blocked.stderr, /timed out/)
  await holder
})

test('--timeout 0 gives up immediately instead of waiting', async () => {
  const holder = finished(heavy(['run', '--label', 'holder', '--', 'sh', '-c', 'sleep 2']))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const refused = await finished(heavy(['run', '--timeout', '0', '--', 'echo', 'should-not-run']))
  assert.equal(refused.code, 75)
  assert.equal(refused.stdout.trim(), '')
  assert.match(refused.stderr, /no room to start/)
  await holder
  // With the lock free it still runs: 0 means "don't queue", not "never run".
  const allowed = await finished(heavy(['run', '--timeout', '0', '--', 'echo', 'ran']))
  assert.equal(allowed.stdout.trim(), 'ran')
})

test('a malformed --timeout is rejected rather than silently defaulted', async () => {
  const result = await finished(heavy(['run', '--timeout', 'soon', '--', 'echo', 'nope']))
  assert.equal(result.code, 2)
  assert.match(result.stderr, /number of seconds/)
})

test('status survives a reader that closes the pipe early', async () => {
  // `heavy status | head -2` used to die with an unhandled EPIPE stack trace.
  const piped = spawn('/bin/sh', ['-c', `"${process.execPath}" "${HEAVY}" status | head -2`],
    { env: heavyEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const { code, stderr } = await finished(piped)
  assert.equal(code, 0)
  assert.doesNotMatch(stderr, /EPIPE/)
})

test('a calm machine runs jobs side by side and raises the limit while they queue', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '4' })
  const jobs = ['a', 'b', 'c', 'd'].map((label) => finished(machine.start(label, 'sleep 3')))
  await until(() => machine.running().length === 4, 'all four jobs running at once')
  assert.equal(machine.state().limit, 4)
  await Promise.all(jobs)
})

test('jobs start one by one, so each shows its load before the next', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '2' })
  const first = finished(machine.start('first', 'sleep 1'))
  const second = finished(machine.start('second', 'sleep 1'))
  await until(() => machine.running().length === 1, 'the first job starting')
  await sleep(150)
  assert.equal(machine.running().length, 1, 'the second job did not wait out the settling time')
  await until(() => machine.running().length === 2, 'the second job starting')
  await Promise.all([first, second])
})

test('a busy CPU holds the next job back, and calm lets it through', async () => {
  const machine = freshMachine()
  machine.set({ cpu: 85 })
  const first = finished(machine.start('first', 'sleep 3'))
  await until(() => machine.running().length === 1, 'the first job starting')
  const second = finished(machine.start('second', 'true'))
  await sleep(600)
  assert.deepEqual(machine.running(), ['first'])
  machine.set({ cpu: 20 })
  assert.equal((await second).code, 0)
  await first
})

test('a busy CPU does not hold back a server, but low memory does', async () => {
  const machine = freshMachine()
  machine.set({ cpu: 85 })
  const first = finished(machine.start('first', 'sleep 3', ['serve']))
  await until(() => machine.running().length === 1, 'the first server starting')
  const second = finished(machine.start('second', 'sleep 3', ['serve']))
  await until(() => machine.running().length === 2, 'the second server starting despite the CPU')
  await Promise.all([first, second])

  machine.set({ freePct: 25 })
  const third = finished(machine.start('third', 'sleep 2', ['serve']))
  await until(() => machine.running().length === 1, 'the third server starting')
  const fourth = finished(machine.start('fourth', 'sleep 1', ['serve', '--timeout', '1']))
  assert.equal((await fourth).code, 75)
  await third
})

test('a pressure warning alone holds nothing back', async () => {
  // macOS sits at warning for long stretches with plenty free and no swapping.
  const machine = freshMachine()
  machine.set({ pressure: 2, freePct: 42 })
  const first = finished(machine.start('first', 'sleep 3'))
  await until(() => machine.running().length === 1, 'the first job starting')
  const second = finished(machine.start('second', 'sleep 3'))
  await until(() => machine.running().length === 2, 'the second job starting at warning')
  assert.equal(machine.state().verdict, 'calm')
  await Promise.all([first, second])
})

test('sandboxed samples cannot hide critical pressure', async () => {
  // A sandboxed wrapper reads no pressure level. Alternating with one that can must
  // neither restart the overload clock nor let the verdict flip back to calm.
  const machine = freshMachine()
  const job = finished(machine.start('victim', 'sleep 8'))
  await until(() => machine.running().length === 1, 'the job starting')
  // Critical for 30ms in every 80. Samples come 60ms apart, so no two in a row can
  // both read it, and only a remembered level can last the 120ms overload needs.
  let finishedYet = false
  const alternate = (async () => {
    while (!finishedYet) {
      machine.set({ pressure: 4 })
      await sleep(30)
      machine.set({ pressure: null })
      await sleep(50)
    }
  })()
  const stopped = await job
  finishedYet = true
  await alternate
  assert.equal(stopped.code, 76)
  assert.match(stopped.stderr, /memory pressure is critical/)
})

test('a critical reading is forgotten once nobody can confirm it', async () => {
  const machine = freshMachine()
  machine.set({ pressure: 4 })
  execFileSync(process.execPath, [HEAVY, 'status'], { env: machine.env })
  machine.set({ pressure: null })
  await sleep(700) // past the 600ms a reading is kept
  execFileSync(process.execPath, [HEAVY, 'status'], { env: machine.env })
  assert.equal(machine.state().reading.pressure, null)
  assert.equal(machine.state().verdict, 'calm')
})

test('one job always gets through a busy machine, so outside load cannot stop all work', async () => {
  const machine = freshMachine()
  machine.set({ cpu: 95, freePct: 25 })
  assert.equal((await finished(machine.start('only', 'true', ['run', '--timeout', '2']))).code, 0)
})

test('an overloaded machine starts nothing at all', async () => {
  const machine = freshMachine()
  machine.set({ freePct: 5 })
  await until(() => { try { execFileSync(process.execPath, [HEAVY, 'status'], { env: machine.env }); return machine.state().verdict === 'overloaded' } catch { return false } }, 'overload being noticed')
  const refused = await finished(machine.start('nope', 'echo should-not-run', ['run', '--timeout', '0']))
  assert.equal(refused.code, 75)
  assert.equal(refused.stdout, '')
  assert.match(refused.stderr, /overloaded: only 5% of memory is free/)
})

test('overload stops the newest job, cuts the limit, and leaves the older jobs alone', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '4' })
  const started = []
  for (const label of ['oldest', 'middle', 'newest']) {
    const child = machine.start(label, 'sleep 30')
    started.push({ child, done: finished(child) })
    await until(() => machine.running().includes(label), `${label} running`)
  }
  await until(() => machine.running().length === 3, 'three jobs running')
  const limitBefore = machine.state().limit

  machine.set({ freePct: 5 })
  const stopped = await started[2].done
  assert.equal(stopped.code, 76)
  assert.match(stopped.stderr, /machine is overloaded \(only 5% of memory is free\)/)
  assert.match(stopped.stderr, /re-run it/)
  assert.deepEqual(machine.running(), ['middle', 'oldest'])
  assert.equal(machine.state().limit, Math.floor(limitBefore / 2))
  machine.set({})

  await endJobs(started.slice(0, 2))
})

test('a short spike stops nothing', async () => {
  const machine = freshMachine()
  const job = finished(machine.start('survivor', 'sleep 2'))
  await until(() => machine.running().length === 1, 'the job starting')
  machine.set({ freePct: 5 })
  await sleep(70) // under the 120ms an overload has to last
  machine.set({})
  assert.equal((await job).code, 0)
  assert.equal(machine.state().stop, null)
})

test('a full CPU alone stops a job only after lasting minutes, and never the last one', async () => {
  const machine = freshMachine({ HEAVY_TIME_SCALE: '0.002', HEAVY_RUN_SLOTS: '2' })
  machine.set({ cpu: 100 })
  const job = finished(machine.start('alone', 'sleep 1.5'))
  assert.equal((await job).code, 0) // 240ms of overload here is two minutes for real
  assert.equal(machine.state().stop, null)

  // Two jobs: admitted while calm, then the CPU saturates.
  machine.set({})
  const first = machine.start('first', 'sleep 30')
  const firstDone = finished(first)
  await until(() => machine.running().length === 1, 'the first job starting')
  const second = finished(machine.start('second', 'sleep 30'))
  await until(() => machine.running().length === 2, 'the second job starting')
  machine.set({ cpu: 100 })
  assert.equal((await second).code, 76)
  machine.set({})
  await endJobs([{ child: first, done: firstDone }])
})

test('every overload makes the next raise take longer, and the wait is remembered', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '4' })
  const overloadOnce = async () => {
    const job = finished(machine.start('victim', 'sleep 30'))
    await until(() => machine.running().length === 1, 'the job starting')
    machine.set({ freePct: 5 })
    assert.equal((await job).code, 76)
    machine.set({})
  }
  await overloadOnce()
  const afterOne = machine.state()
  assert.equal(afterOne.limit, 1)
  assert.equal(afterOne.growMs, 1200)

  await sleep(650) // past the gap between stops
  await overloadOnce()
  const afterTwo = machine.state()
  assert.equal(afterTwo.limit, 1)
  assert.equal(afterTwo.growMs, 2400)

  // Calm again with one job running and another queued: the raise waits out the
  // longer backoff rather than the usual 600ms.
  const started = Date.now()
  const holder = finished(machine.start('holder', 'sleep 4'))
  await until(() => machine.running().length === 1, 'the holder starting')
  const waiter = finished(machine.start('waiter', 'sleep 0.2'))
  await until(() => machine.state().limit === 2, 'the limit rising again')
  assert.ok(Date.now() - started >= 2000, `raised after only ${Date.now() - started}ms`)
  await Promise.all([holder, waiter])
})

test('a quiet machine earns no raise: only jobs held back by the limit do', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '4' })
  const job = finished(machine.start('solo', 'sleep 1.5'))
  await job
  assert.equal(machine.state().limit, 2)
})

test('servers are stopped only once no test run is left to stop', async () => {
  const machine = freshMachine()
  const server = finished(machine.start('server', 'sleep 30', ['serve']))
  await until(() => machine.running().length === 1, 'the server starting')
  const tests = finished(machine.start('tests', 'sleep 30'))
  await until(() => machine.running().length === 2, 'the tests starting')
  machine.set({ freePct: 5 })
  assert.equal((await tests).code, 76, 'the older test run went before the server')
  assert.equal((await server).code, 76, 'the server goes next if the machine stays overloaded')
})

test('a stopped job loses anything else in its process group too', async () => {
  const machine = freshMachine()
  const marker = path.join(machine.dir, 'orphan-survived')
  const job = finished(machine.start('parent', `(sleep 1; touch ${marker}) & wait`))
  await until(() => machine.running().length === 1, 'the job starting')
  machine.set({ freePct: 5 })
  assert.equal((await job).code, 76)
  await sleep(1200)
  assert.equal(fs.existsSync(marker), false)
})

test('where memory cannot be read, heavy stays at one job at a time', async () => {
  const machine = freshMachine({ HEAVY_RUN_SLOTS: '4' })
  machine.set({ freePct: null })
  const first = finished(machine.start('first', 'sleep 2'))
  await until(() => machine.running().length === 1, 'the first job starting')
  const second = await finished(machine.start('second', 'true', ['run', '--timeout', '1']))
  assert.equal(second.code, 75)
  assert.match(second.stderr, /one at a time/)
  await first
})

test('measuring works with no scripted readings, as it does under a sandbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-test-'))
  const env = { ...process.env, HEAVY_DIR: dir }
  delete env.HEAVY_READINGS
  const { machine } = JSON.parse(execFileSync(process.execPath, [HEAVY, 'status', '--json'], { env, encoding: 'utf8' }))
  assert.equal(typeof machine.reading.cpu, 'number')
  assert.equal(typeof machine.reading.swapMBps, 'number')
  assert.equal(typeof machine.reading.freePct, 'number')
})

test('every lock is released once the jobs are done', () => {
  const report = status()
  assert.deepEqual(report.run.holders, [])
  assert.deepEqual(report.serve.holders, [])
  assert.equal(report.run.waiting + report.serve.waiting, 0)
})
