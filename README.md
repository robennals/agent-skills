# agent-skills

Plugins and skills for coding agents, by [Rob Ennals](https://github.com/robennals).

## Install

```
/plugin marketplace add robennals/agent-skills
/plugin install heavy@robennals-agent-skills
```

Or from a terminal:

```sh
claude plugin marketplace add robennals/agent-skills
claude plugin install heavy@robennals-agent-skills
```

## What's here

### heavy

**Stops parallel agents from wedging your machine.** If you run several agent
sessions on one laptop, they will all decide to run the test suite at the same
moment. `heavy` puts a machine-wide lock in front of expensive commands: one
CPU-heavy job at a time, at most two long-lived servers, everyone else queues.

```sh
heavy run   -- npm test        # tests, typecheck, build, E2E, lint: one at a time
heavy serve -- npm run dev     # dev servers and watchers: at most two at once
heavy status                   # who holds the locks, who is queued
```

A `PreToolUse` hook denies any unwrapped expensive Bash command and names the
wrapped form to use instead, so agents comply without being reminded. When a
lock is busy, `heavy` names the command, branch, session, and directory holding
it — so "both server slots are taken" becomes "go ask the session on this
branch".

One step after installing, because a plugin cannot change your PATH:

```
/heavy:install
```

Details: [plugins/heavy](plugins/heavy).

## Working on these locally

A plugin directory placed in `~/.claude/skills/` loads live from disk, with no
install or update step. Symlink a checkout there and edits apply in the next
session:

```sh
git clone git@github.com:robennals/agent-skills.git
ln -s "$PWD/agent-skills/plugins/heavy" ~/.claude/skills/heavy
```

`claude plugin list` will show it as `heavy@skills-dir`, and
`claude plugin details heavy@skills-dir` lists the components it loaded.

An installed copy of the same plugin **takes precedence** over the
`~/.claude/skills` one, so switching between the version you are editing and
the published version is install/uninstall:

```sh
# test what everyone else gets
claude plugin marketplace add robennals/agent-skills
claude plugin install heavy@robennals-agent-skills

# go back to editing your checkout
claude plugin uninstall heavy@robennals-agent-skills
```

`claude plugin list` says which copy won and why.

**Bump `version` in `plugins/heavy/.claude-plugin/plugin.json` for every
change you want others to get.** `claude plugin update` compares versions, so a
push that leaves the version alone reports "already at the latest version" and
installs nothing. `claude plugin tag` creates a matching git tag and checks the
manifest and marketplace entry agree.

Before pushing:

```sh
claude plugin validate . --strict
claude plugin validate plugins/heavy --strict
cd plugins/heavy && node --test test/heavy.test.js
```

Note that `claude plugin marketplace add` needs `./` for a local path — a bare
`.` is rejected.

## License

MIT
