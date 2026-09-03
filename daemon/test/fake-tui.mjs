// A terminal application that behaves like the one the bug was found in.
//
// The whole failure lives in somebody else's TUI, so a mock of the writer
// proves nothing: what has to be reproduced is a real pty, real bracketed
// paste, and an application that commits a paste to its input box on its own
// schedule and drops whatever keys arrive while it is doing so. That last part
// is not malice, it is what an input loop that treats a paste as one event
// does with a Return it reads in the same breath — and it is exactly why a
// message with a picture on it landed in a composer and was reported sent.
//
// Two modes, because the fix has two halves. `paste` is the bug: a Return that
// arrives while a paste is settling is eaten, and one that arrives afterwards
// submits. `deaf` never submits anything, which is the case the daemon has to
// notice and tell the phone about rather than paper over.
//
// Run as `node fake-tui.mjs <log> <mode> <settle-ms>`; imported, it is just
// the path to itself.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where this file is, for a suite that wants to start one in a pane. */
export const FAKE_TUI = fileURLToPath(import.meta.url)

/** Every submitted message is appended here, one per record. */
export const SEPARATOR = '\n<<<sent>>>\n'

// Imported rather than run: nothing below should happen.
if (process.argv[1] === FAKE_TUI) main()

function main() {
  const log = process.argv[2]
  const mode = process.argv[3] || 'paste'
  const SETTLE_MS = Number(process.argv[4] || 400)

  /** What is in the input box. */
  let held = ''
  /** Mid-paste: everything up to the closing bracket belongs to the box. */
  let pasting = false
  let pasted = ''
  /** The window in which this application is deaf to keys, and the bug. */
  let settling = false
  let timer = null

  const WIDTH = 60

  function draw() {
    const rows = held === '' ? [''] : held.split('\n')
    const out = [
      '\x1b[2J\x1b[H',
      'a terminal that is not really an agent',
      '',
      `╭${'─'.repeat(WIDTH)}╮`,
      ...rows.map((row) => `│ > ${row}\x1b[K`),
      `╰${'─'.repeat(WIDTH)}╯`,
      '  fake · ctx 0%',
    ]
    process.stdout.write(out.join('\r\n'))
  }

  function submit() {
    if (mode === 'deaf') return
    fs.appendFileSync(log, held + SEPARATOR)
    held = ''
    draw()
  }

  function keys(text) {
    for (const ch of text) {
      // The bug, in one line: a key read while a paste is still being taken
      // in is not a key, it is part of the paste, and it is dropped.
      if (ch === '\r' || ch === '\n') {
        if (!settling) submit()
        continue
      }
      if (ch === '\x03') process.exit(0)
      held += ch
    }
    draw()
  }

  function commit() {
    const text = pasted
    pasted = ''
    settling = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      // tmux's paste buffer carries the newlines as carriage returns, the way
      // a keyboard would; a TUI taking a paste puts the lines back together.
      held += text.replace(/\r\n?/gu, '\n')
      settling = false
      draw()
    }, SETTLE_MS)
  }

  const OPEN = '\x1b[200~'
  const CLOSE = '\x1b[201~'

  process.stdin.setRawMode?.(true)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  // Bracketed paste on, which is what makes tmux send a paste as a paste.
  process.stdout.write('\x1b[?2004h')

  process.stdin.on('data', (chunk) => {
    let rest = String(chunk)
    while (rest.length) {
      if (pasting) {
        const end = rest.indexOf(CLOSE)
        if (end < 0) {
          pasted += rest
          rest = ''
        } else {
          pasted += rest.slice(0, end)
          rest = rest.slice(end + CLOSE.length)
          pasting = false
          commit()
        }
        continue
      }
      const start = rest.indexOf(OPEN)
      if (start === 0) {
        pasting = true
        rest = rest.slice(OPEN.length)
        continue
      }
      const upto = start < 0 ? rest.length : start
      keys(rest.slice(0, upto))
      rest = rest.slice(upto)
    }
  })

  draw()
}
