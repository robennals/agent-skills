#!/usr/bin/env node
// PreToolUse(Bash) guard: expensive commands must go through `heavy`, so that
// only one CPU-heavy job and a bounded number of servers run on this machine at
// a time, no matter how many agent sessions are working. See skills/heavy/SKILL.md.

import fs from 'node:fs'
import path from 'node:path'

const BYPASS = new Set(['0', 'off', 'false'])

// Subcommands and scripts worth serializing. Anything matching SERVER_SCRIPT is
// long-lived and belongs in the `serve` pool instead of the `run` mutex.
const HEAVY_SCRIPT = /^(test|tests|build|dev|start|serve|preview|watch|lint|typecheck|check|e2e|ci|storybook|integration)/
const SERVER_SCRIPT = /^(dev|start|serve|preview|watch|storybook)/
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const RUNNERS = new Set(['npx', 'bunx', 'dlx'])
const HEAVY_BINARIES = new Set([
  'tsc', 'vitest', 'jest', 'mocha', 'playwright', 'cypress', 'eslint',
  'next', 'vite', 'webpack', 'turbo', 'nx', 'storybook',
  'gradle', 'gradlew', 'mvn', 'pytest', 'tox', 'make', 'mprocs',
])
const SERVER_BINARIES = new Set(['mprocs', 'storybook'])
// Tools where only some subcommands are expensive.
const SUBCOMMAND_TOOLS = {
  cargo: new Set(['build', 'test', 'run', 'clippy', 'bench']),
  go: new Set(['build', 'test', 'run']),
  docker: new Set(['build', 'compose']),
}
const NOISE_PREFIXES = new Set(['sudo', 'time', 'nohup', 'command', 'exec'])
const INERT_FLAGS = new Set(['--help', '-h', '--version', '-v', '--list'])

function allow() {
  process.exit(0)
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

function heavyOnPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, 'heavy'), fs.constants.X_OK)
      return true
    } catch {}
  }
  return false
}

// A heredoc body is data, not commands: `cat > f <<'EOF' ... npm test ... EOF`
// writes a file, and reading its contents as invocations is a false positive.
function stripHeredocs(command) {
  const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/
  let result = command
  for (;;) {
    const match = opener.exec(result)
    if (!match) return result
    const bodyStart = result.indexOf('\n', match.index)
    // An unterminated heredoc means everything after it is body.
    if (bodyStart === -1) return result.slice(0, match.index)
    const terminator = result.indexOf(`\n${match[2]}`, bodyStart)
    result = terminator === -1
      ? result.slice(0, match.index)
      : result.slice(0, match.index) + result.slice(terminator + match[2].length + 1)
  }
}

// Split on shell separators without splitting inside quotes, so that a quoted
// `&&` in an argument does not invent a second segment.
function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      current += char
      if (char === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      segments.push(current)
      current = ''
      // Consume the second character of `&&` and `||`.
      if (command[i + 1] === char) i++
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function tokenize(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  // Drop leading `FOO=bar` assignments and wrappers that are not the real command.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || NOISE_PREFIXES.has(tokens[0]))) {
    tokens.shift()
  }
  return tokens
}

// Returns 'run', 'serve', or null (cheap enough to run unthrottled).
function classify(tokens) {
  if (!tokens.length) return null
  if (tokens.some((token) => INERT_FLAGS.has(token))) return null

  const name = path.basename(tokens[0])
  if (name === 'heavy') return null // already wrapped

  const watching = tokens.some((token) => token === '--watch' || token === '-w')
  const watchClass = watching ? 'serve' : 'run'

  if (PACKAGE_MANAGERS.has(name)) {
    const verb = tokens[1]
    // `npm exec` / `pnpm dlx` run a binary, not a package script, so the real
    // command is whatever follows.
    if (verb === 'exec' || RUNNERS.has(verb)) return tokens[2] ? classify(tokens.slice(2)) : null
    const script = verb === 'run' || verb === 'run-script' ? tokens[2] : verb
    if (!script) return null // bare `npm run` just lists scripts
    if (!HEAVY_SCRIPT.test(script)) return null
    return SERVER_SCRIPT.test(script) || watching ? 'serve' : 'run'
  }

  if (RUNNERS.has(name)) return tokens[1] ? classify(tokens.slice(1)) : null

  if (name === 'bb') {
    if (tokens[1] !== 'plugin') return null
    if (tokens[2] === 'dev') return 'serve'
    return tokens[2] === 'build' ? 'run' : null
  }

  const subcommands = SUBCOMMAND_TOOLS[name]
  if (subcommands) {
    if (!subcommands.has(tokens[1])) return null
    if (name === 'docker' && tokens[1] === 'compose') {
      return tokens.includes('up') ? 'serve' : tokens.includes('build') ? 'run' : null
    }
    return watchClass
  }

  if (SERVER_BINARIES.has(name)) return 'serve'
  if (HEAVY_BINARIES.has(name)) {
    if (name === 'next' || name === 'vite') {
      return SERVER_SCRIPT.test(tokens[1] || 'dev') ? 'serve' : 'run'
    }
    return watchClass
  }
  return null
}

function reasonFor(cls, segment) {
  const wrapped = `heavy ${cls} -- ${segment.trim()}`
  const shared = cls === 'run'
    ? 'CPU-heavy commands run one at a time across every agent session on this machine'
    : 'long-lived servers are capped so they cannot eat all the memory'
  return [
    `Blocked: ${shared}, so this has to go through the \`heavy\` wrapper.`,
    '',
    `Wrap that part of the command:  ${wrapped}`,
    '(only this part — keep any surrounding `cd`, pipe, or redirection outside the wrapper.)',
    '',
    cls === 'run'
      ? 'It queues behind any job already holding the lock, so for anything slow pass run_in_background: true rather than fighting the Bash timeout. `heavy status` shows who holds it.'
      : 'It takes one of a small number of server slots and holds it until the process exits. If you need several servers at once, run them under a single `heavy serve -- mprocs ...`.',
  ].join('\n')
}

const input = readStdin()
if (!input || input.tool_name !== 'Bash') allow()
if (BYPASS.has(String(process.env.HEAVY_GUARD || '').toLowerCase())) allow()
// Never wedge a machine that has no wrapper installed.
if (!heavyOnPath()) allow()

const command = input.tool_input?.command
if (typeof command !== 'string') allow()

for (const segment of splitSegments(stripHeredocs(command))) {
  const cls = classify(tokenize(segment))
  if (cls) deny(reasonFor(cls, segment))
}
allow()
