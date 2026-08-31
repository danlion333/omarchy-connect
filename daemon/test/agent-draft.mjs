// The sentence in flight, taken off a pane instead of out of a file.
//
// Claude Code writes an assistant entry only once the message is finished, so
// the words a phone wants while they are arriving exist nowhere but the
// terminal drawing them. Reading a screen is a guess about somebody else's
// redraw, and this is where the guess is pinned down: the fixtures below are
// the shapes a real pane takes, and every one of them either yields prose or
// yields nothing, because a tool's name shown to somebody as though the agent
// had said it is worse than a draft that never appeared.
import { draftOf } from '../src/agents/claude.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** A pane, drawn at the width its rules are drawn at. */
const WIDTH = 80
const rule = '─'.repeat(WIDTH)
const pane = (...lines) => [...lines, '', rule, '❯', rule, '  Opus 5 (1M context) · ctx 7%'].join('\n')

/* ── prose, arriving ───────────────────────────────────────────────────── */

// Wrapped at the pane's edge, which is not the phone's edge: the breaks the
// terminal put in have to come back out or the paragraph arrives in ribbons.
const wrapped = pane(
  '❯ поясни різницю',
  '',
  '● Транскрипт не стрімить, бо запис у файл з’являється лише після того, як',
  '  повідомлення завершилось. Панель малює',
  '',
  '· Pollinating… (38s · ↓ 2.4k tokens)',
)
check(
  'a paragraph mid-flight comes back as one line',
  draftOf(wrapped) ===
    'Транскрипт не стрімить, бо запис у файл з’являється лише після того, як повідомлення завершилось. Панель малює',
  JSON.stringify(draftOf(wrapped)),
)

check(
  'the spinner under it is status, not conversation',
  !String(draftOf(wrapped)).includes('Pollinating'),
)

check(
  'and so is the composer below that',
  !String(draftOf(wrapped)).includes('Opus 5'),
)

// A list rewrapped into a paragraph is a list destroyed, so a line that starts
// an item keeps its own line however full the line above it was.
const list = pane(
  '● Два шляхи:',
  '',
  '  - панель, яку вже читає agents.screen, і яка справді росте по словах поки',
  '    агент друкує далі і далі й далі',
  '  - headless-сесія',
)
check(
  'a list keeps its items and loses only the wrapping',
  draftOf(list) ===
    'Два шляхи:\n\n- панель, яку вже читає agents.screen, і яка справді росте по словах поки агент друкує далі і далі й далі\n- headless-сесія',
  JSON.stringify(draftOf(list)),
)

/* ── everything that is not the agent talking ──────────────────────────── */

check('a call that has answered is not prose', draftOf(pane('● Bash(ls -la)', '  ⎿  total 24', '     drwxr-xr-x')) === null)

// The window between a call being drawn and its output arriving is the one
// that used to leak: nothing under the bullet yet, so nothing said it was a
// call except the shape of the line itself.
check('nor is one that has not answered yet', draftOf(pane('● Read(SKILL.md)')) === null)

check(
  'a call under the last thing said hides the paragraph above it',
  draftOf(pane('● Ось що я знайшов', '', '● Bash(ls)', '  ⎿  total 0')) === null,
)

check('an empty pane says nothing', draftOf('') === null)
check('and neither does one with only a composer in it', draftOf(pane()) === null)

// A tool this build draws as an indented title with an elbow under it rather
// than as a bullet. Prose *above* a run that has already answered is prose the
// file has already delivered — the CLI records the sentence and the call it
// led to as one entry — so there is nothing to draft here, and saying so is
// what keeps a finished paragraph from being repeated under itself.
check(
  'prose above a finished tool run is the file’s to deliver, not the screen’s',
  draftOf(pane('● Читаю код детально перед змінами.', '', '  Reading herdr capture', '  ⎿  $ cat file')) === null,
)

// The next sentence, though, is below the run and is nobody else's yet.
check(
  'the sentence after that run is the draft',
  draftOf(pane('  Reading herdr capture', '  ⎿  $ cat file', '', '● Ось що я знайшов у файлі')) ===
    'Ось що я знайшов у файлі',
  JSON.stringify(draftOf(pane('  Reading herdr capture', '  ⎿  $ cat file', '', '● Ось що я знайшов у файлі'))),
)

/* ── growing ───────────────────────────────────────────────────────────── */

// What the daemon leans on to send a few words instead of a paragraph: a draft
// that grew is the one before it plus a suffix.
const first = draftOf(pane('● Транскрипт не стрімить, бо запис'))
const second = draftOf(pane('● Транскрипт не стрімить, бо запис у файл з’являється лише після'))
check('a growing draft keeps the one before it as its prefix', second.startsWith(first), JSON.stringify(second.slice(first.length)))

/* ── done ──────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} draft checks passed`)
if (failed.length) process.exit(1)
