// Whether the message actually left the composer.
//
// A phone that dictates a sentence, attaches a photo and presses send used to
// get a cleared composer, a row saying the agent was working, and an agent
// that had been asked nothing at all: the paths and the caption make a
// multi-line body, a multi-line body goes to a TUI as a bracketed paste, and
// the Return written on the paste's heels was swallowed along with it. Both
// halves of the write succeeded, so `submitted` — which was the flag the
// caller had asked for, echoed back — said yes.
//
// So this suite is about the one thing that cannot be mocked: a real pty with
// bracketed paste on, and an application at the far end of it that commits a
// paste on its own schedule. `fake-tui.mjs` is that application.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, done } from '../../tools/test-harness.mjs'
import { FAKE_TUI, SEPARATOR } from './fake-tui.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-connect-submit-'))
// The writing half shells out to tmux, and whoever is running this suite very
// likely has sessions of their own open. A private socket directory keeps this
// test's panes out of them — and the modules below inherit it, because they
// spawn tmux with this process's environment.
process.env.TMUX_TMPDIR = sandbox
delete process.env.TMUX

const { composerOf, submitted } = await import('../src/agents/composer.js')
const writer = await import('../src/agents/writer.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── reading a composer off a screen ───────────────────────────────────── */

// The shape Claude Code draws: a box at the bottom, a status line under it,
// and the conversation above.
const drawn = (...held) =>
  [
    '● Reading the file.',
    '',
    `╭${'─'.repeat(60)}╮`,
    ...(held.length ? held : ['']).map((line) => `│ > ${line}`),
    `╰${'─'.repeat(60)}╯`,
    '  Opus 5 · ctx 7%',
  ].join('\n')

check('an empty box reads as an empty composer', composerOf(drawn()) === '', JSON.stringify(composerOf(drawn())))
check(
  'a message waiting in the box is what comes back',
  composerOf(drawn('/tmp/a shot.png', 'why is this off by one?')) === '/tmp/a shot.png\nwhy is this off by one?',
  JSON.stringify(composerOf(drawn('/tmp/a shot.png', 'why is this off by one?'))),
)
// The one that matters for a phone: a TUI that collapses a paste into a chip
// still has *something* in the box, and something is not nothing.
check('a collapsed paste still reads as a full composer', composerOf(drawn('[Pasted text #1 +3 lines]')) !== '')

// A screen with no box in it must say "cannot tell", never "not submitted" —
// a bare shell is most of what this daemon writes into, and accusing one of
// eating a message would have a phone hand back text that did arrive.
const shell = ['$ ls', 'README.md  daemon  app', '$ '].join('\n')
check('a bare shell has no composer to read', composerOf(shell) === null, JSON.stringify(composerOf(shell)))
check('and neither has an empty pane', composerOf('') === null)
// A table printed into the scrollback is a box, but not one at the bottom of
// the screen with a prompt in it.
const table = [`╭${'─'.repeat(40)}╮`, '│ a │ b │', `╰${'─'.repeat(40)}╯`, ...Array(12).fill('output'), '$ '].join('\n')
check('a box far above the prompt is not a composer', composerOf(table) === null, JSON.stringify(composerOf(table)))

check('an empty box afterwards is a message that left', submitted('', '') === true)
check('a box that gained the message is one that did not', submitted('', 'hello there') === false)
check('a box that held something before and still does is not an accusation', submitted('half a line', 'half a line') === true)
check('and an unreadable screen is never an accusation', submitted('', null) === true)

/* ── the pty, and a TUI that eats the Return ───────────────────────────── */

let hasTmux = true
try {
  execFileSync('which', ['tmux'], { stdio: 'ignore' })
} catch {
  hasTmux = false
}

const tmux = (args) => execFileSync('tmux', args, { env: process.env, encoding: 'utf8' }).trim()

/** A pane running the fake TUI, and the pane id to write into. */
function pane(name, mode, settle = 400) {
  const log = path.join(sandbox, `${name}.log`)
  fs.writeFileSync(log, '')
  tmux([
    'new-session', '-d', '-s', name, '-x', '100', '-y', '30',
    `${process.execPath} ${FAKE_TUI} ${log} ${mode} ${settle}`,
  ])
  return { log, entry: { writable: 'tmux', pane: tmux(['list-panes', '-t', name, '-F', '#{pane_id}']) } }
}

const sent = (log) => fs.readFileSync(log, 'utf8').split(SEPARATOR).filter(Boolean)

if (!hasTmux) {
  console.log('  skip  tmux is not installed — the pty half was not exercised')
} else {
  /* ── a dictated message with a photo on it ───────────────────────────── */

  const shot = pane('oc-submit', 'paste', 400)
  await sleep(500)

  const BODY = '/home/dan/.cache/omarchy-connect/agent/a-shot.png\nчому це на одиницю більше?'
  const withShot = await writer.send(shot.entry, BODY)
  check('a message with a picture on it is submitted', withShot.submitted === true, JSON.stringify(withShot))
  check('and the agent actually received it', sent(shot.log)[0] === BODY, JSON.stringify(sent(shot.log)))
  check('exactly once', sent(shot.log).length === 1, String(sent(shot.log).length))

  // Several pictures at once is the same body with more paths on the first
  // line, and the same paste that used to lose its Return.
  const MANY = ['/tmp/one.png /tmp/two.png /tmp/three.png', 'which of these is wrong?'].join('\n')
  const many = await writer.send(shot.entry, MANY)
  check('so is one with three pictures on it', many.submitted === true, JSON.stringify(many))
  check('and it arrives whole', sent(shot.log)[1] === MANY, JSON.stringify(sent(shot.log)[1]))

  // A photo with no caption at all — the share sheet's own case.
  const bare = await writer.send(shot.entry, '/tmp/one.png')
  check('a bare path with no caption goes too', bare.submitted === true && sent(shot.log)[2] === '/tmp/one.png')

  // The single-line road never had the bug and must not grow one.
  const plain = await writer.send(shot.entry, 'так, продовжуй')
  check('a one-line message still goes in one write', plain.submitted === true, JSON.stringify(plain))
  check('and utf-8 survives it', sent(shot.log)[3] === 'так, продовжуй', JSON.stringify(sent(shot.log)[3]))

  // Asked not to submit: the text is put in front of the agent and left
  // there, which is a draft and not a failure.
  const draft = await writer.send(shot.entry, 'a line\nand another', { submit: false })
  check('a draft says it was not submitted', draft.submitted === false, JSON.stringify(draft))
  await sleep(600)
  check('and nothing more reached the agent', sent(shot.log).length === 4, String(sent(shot.log).length))

  const screen = await writer.screen(shot.entry, 20)
  check('the draft is sitting in the composer', composerOf(screen).includes('and another'), JSON.stringify(composerOf(screen)))

  tmux(['kill-session', '-t', 'oc-submit'])

  /* ── a TUI that never takes it ───────────────────────────────────────── */

  // The message is typed, the Return is pressed twice, and the box still holds
  // it. This is the answer a phone must be given rather than a cleared
  // composer and a row that says the agent is working.
  const deaf = pane('oc-deaf', 'deaf', 100)
  await sleep(500)
  const lost = await writer.send(deaf.entry, '/tmp/one.png\nis this right?')
  check('a message that never left says so', lost.submitted === false, JSON.stringify(lost))
  check('and the agent was asked nothing', sent(deaf.log).length === 0, JSON.stringify(sent(deaf.log)))
  const stuck = composerOf(await writer.screen(deaf.entry, 20))
  check('the text is still where the daemon put it', String(stuck).includes('is this right?'), JSON.stringify(stuck))
  tmux(['kill-session', '-t', 'oc-deaf'])

  /* ── a pane with nothing to read ─────────────────────────────────────── */

  // `cat` has no composer, so there is no evidence either way, and the daemon
  // must not invent any: a phone told its message failed would send it twice.
  const catLog = path.join(sandbox, 'cat.log')
  tmux(['new-session', '-d', '-s', 'oc-cat', '-x', '100', '-y', '30', `cat > ${catLog}`])
  await sleep(400)
  const blind = await writer.send({ writable: 'tmux', pane: tmux(['list-panes', '-t', 'oc-cat', '-F', '#{pane_id}']) }, 'one\ntwo')
  check('a screen with no composer is not evidence of a failure', blind.submitted === true, JSON.stringify(blind))
  await sleep(400)
  check('and the bytes still reached the far end', fs.readFileSync(catLog, 'utf8').includes('one\ntwo'))
  tmux(['kill-session', '-t', 'oc-cat'])
}

// The private server exists only for this suite; a run that never started one
// has nothing to kill and says so on stderr, which is not news.
try {
  execFileSync('tmux', ['kill-server'], { env: process.env, stdio: 'ignore' })
} catch {
  /* there was no server to kill */
}
fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
done()
