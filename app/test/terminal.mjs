/**
 * The Terminal workspace.
 *
 * Two halves, as `offline-shade` has. The first is arithmetic — `lib/terminal`
 * turns a pane into lines, a path into a title, a history into chips and a
 * panel into the `cols`/`rows` the desktop wraps the shell to — and can simply
 * be run. The second is the screen itself, which needs a native runtime this
 * repository does not have, so what a suite can do is hold its source to the
 * claims the acceptance criteria make about it: that it types into the shell
 * rather than at a window, that nothing on it polls, and that the subscription
 * is dropped when nobody is looking.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'
import { MAX_COMMANDS, fitCols, fitRows, rememberCommand, screenLines, shortPath } from '../src/lib/terminal.ts'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const screen = fs.readFileSync(path.join(root, 'app/src/screens/TerminalScreen.tsx'), 'utf8')
const link = fs.readFileSync(path.join(root, 'app/src/api/link.ts'), 'utf8')

/* ── the local history ──────────────────────────────────────────────────── */

const one = rememberCommand([], 'ls -la')
check('a command sent is a command remembered', one.length === 1 && one[0] === 'ls -la')

const two = rememberCommand(one, 'cd ~/Projects')
check('the newest command is first', two[0] === 'cd ~/Projects')
check('and the older one is still there', two[1] === 'ls -la')
check('the old array is left alone', one.length === 1)

const again = rememberCommand(two, 'ls -la')
check('running something twice adds no second chip', again.length === 2)
check('it moves to the front instead', again[0] === 'ls -la')

check('whitespace is not a command', rememberCommand(two, '   ') === two)
check('a command is stored trimmed', rememberCommand([], '  git status  ')[0] === 'git status')

let long = []
for (let i = 0; i < MAX_COMMANDS + 5; i++) long = rememberCommand(long, `run-${i}`)
check('the history stops growing', long.length === MAX_COMMANDS)
check('the newest survives', long[0] === `run-${MAX_COMMANDS + 4}`)
check('the oldest falls off the end', !long.includes('run-0'))

/* ── the pane, made ready to draw ───────────────────────────────────────── */

check('nothing captured is no lines', screenLines(null).length === 0 && screenLines('').length === 0)

// What `capture-pane` actually hands back: the whole window height, blank
// where the shell has not printed. Drawing those blanks would pin a two-line
// shell to the top of the phone with an empty half underneath.
const captured = ['', '', '~ $ echo hello-from-phone', 'hello-from-phone', '~ $ ', '', '', ''].join('\n')
const drawn = screenLines(captured)
check('the blank tail is cut', drawn[drawn.length - 1] === '~ $')
check('the blank head is cut', drawn[0] === '~ $ echo hello-from-phone')
check('what the shell said is all that is left', drawn.length === 3)
check('the output is the line it printed', drawn[1] === 'hello-from-phone')

check('a blank line inside the output stays', screenLines('a\n\nb').length === 3)
check('carriage returns do not become empty lines', screenLines('a\r\nb').length === 2)
check('the right-hand padding goes', screenLines('$ ls    ')[0] === '$ ls')

/* ── where the shell is ─────────────────────────────────────────────────── */

check('a home is a tilde', shortPath('/home/dan') === '~')
check('and so is everything under it', shortPath('/home/dan/Projects') === '~/Projects')
check('the user is whoever it is', shortPath('/home/someone-else/src') === '~/src')
check('macOS spells home differently', shortPath('/Users/dan/Projects') === '~/Projects')
check('root has one too', shortPath('/root/tmp') === '~/tmp')
check('anywhere else stays absolute', shortPath('/etc/systemd') === '/etc/systemd')
check('a home-shaped name that is not one is left alone', shortPath('/homework/notes') === '/homework/notes')
check('no directory yet is no title', shortPath(null) === null)

/* ── the size the desktop wraps to ──────────────────────────────────────── */

// A 360dp phone: 16dp of screen padding each side, 12dp of panel padding.
check('a handset asks for about fifty columns', fitCols(360 - 32 - 24, 10) === 50)
check('rows come off the panel height', fitRows(420, 14) === 30)
check('a panel not laid out yet asks for nothing', fitCols(0, 10) === 0 && fitRows(0, 14) === 0)
check('nothing outside what the daemon takes is ever sent', fitCols(40, 10) === 0 && fitCols(100000, 10) === 500)

/* ── the screen's own claims ────────────────────────────────────────────── */

check('the shell is typed into, not the focused window', screen.includes("'terminal.type'") && screen.includes("'terminal.key'"))
check("nothing on this screen pushes keys at a window any more", !/call\(\s*'input\./.test(screen))
check('the pane is opened and given up again', screen.includes("'terminal.open'") && screen.includes("'terminal.close'"))
check('the desk can be handed the same session', screen.includes("'terminal.attach'"))
check('the screen arrives as an event', screen.includes("client.on('ev:terminal'"))
check('and nothing polls for it', !/setInterval/.test(screen))
check('the subscription is held while it is held at all', screen.includes('client.subscribe([EVENT])') && screen.includes('client.unsubscribe([EVENT])'))
check('the app being in front is half of whether it is held', screen.includes("AppState.addEventListener('change'"))
check('and this workspace being the one on screen is the other half', screen.includes('connected && visible && active'))
// The one subscription a switched-off screen still needs: `kind: "control"`
// arrives on the feed itself, so a phone that waited to be allowed before it
// listened would never learn that it had been.
check('the feed is held even while the shell is off', /looking\b[\s\S]{0,200}client\.subscribe\(\[EVENT\]\)/.test(screen))
check('and the pane is only read when there is one to read', /watching = looking && enabled && available/.test(screen))
check('the off state says the one command that fixes it', screen.includes('omarchy-connect terminal on'))
check('no tmux is one hint and not an empty card', /no tmux[\s\S]{0,400}<\/Screen>/.test(screen))
check('Ctrl+C knows whether there is anything to interrupt', screen.includes("active={running}"))
check('a line of the shell is copied by long press', screen.includes('onLongPress={() => copyLine'))
check('a command comes back into the field with one tap', screen.includes('onPress={() => setDraft(command)}'))
check('the window class check is gone with the keyboard it served', !screen.includes('isTerminalClass'))
check('and so is the log of what this phone sent', !screen.includes('SentLog'))

check('the desktop switch reaches the screen without a reconnect', link.includes('terminalSwitched'))
check('it is the capabilities that are patched', /capabilities\.terminal = \{/.test(link))

done()
