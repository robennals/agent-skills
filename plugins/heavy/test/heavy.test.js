// node --test claude/bin/heavy.test.js
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
const heavyEnv = { ...process.env, HEAVY_DIR: lockDir }

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

test('run is a mutex: a second job waits for the first', async () => {
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
test('run never lets two jobs overlap, even when they all start at once', async () => {
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

test('serve admits up to its capacity at once', async () => {
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
  assert.match(blocked.stderr, /2 of 2 'serve' slots in use/)
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
  assert.match(refused.stderr, /is busy/)
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

test('every lock is released once the jobs are done', () => {
  const report = status()
  assert.deepEqual(report.run.holders, [])
  assert.deepEqual(report.serve.holders, [])
  assert.equal(report.run.waiting + report.serve.waiting, 0)
})
