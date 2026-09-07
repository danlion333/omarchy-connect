/**
 * The Omarchy bar is the five workspaces and nothing else.
 *
 * The bar used to carry a tray on the right: a link dot, a wifi glyph that was
 * static and had never shown anything, the desktop's notification silencing,
 * and a clock. Every one of those either repeated a screen (the link state,
 * the silencing toggle on Home) or repeated the phone's own status bar half a
 * screen above (the clock, the network), and the tray's only interaction —
 * jumping to Setup — is what workspace 5 already does.
 *
 * There is no way for a suite here to mount `App.tsx` and look at the bar: the
 * app's tree needs a native runtime this repository's tests do not have. What
 * a suite can do is hold the source to its claim, which is a claim about the
 * source anyway — the tray is gone, and with it the hooks and imports that
 * existed only to feed it, because an unused import is the thing that quietly
 * comes back and drags the tray with it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, done } from '../../tools/test-harness.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const app = fs.readFileSync(path.join(root, 'app/App.tsx'), 'utf8')
const design = fs.readFileSync(path.join(root, 'app/DESIGN.md'), 'utf8')

// The tray's four pieces, by the names they were written under.
check('no link dot in the bar', !/\bStatusDot\b/.test(app))
check('no wifi glyph', !/name="wifi"/.test(app))
check('no silencing bell', !/'bell-off'|"bell-off"|name="bell"/.test(app))
check('no clock', !/\buseClock\b/.test(app))

// What only the tray needed. `useToggles` stays alive for Home and `StatusDot`
// for the screens; what must go is `App.tsx` importing them for nobody.
for (const [what, pattern] of [
  ['@expo/vector-icons', /from '@expo\/vector-icons'/],
  ['useToggles', /\buseToggles\b/],
]) {
  check(`App.tsx no longer imports ${what}`, !pattern.test(app))
}

// The bar's own body: one `tablist` whose only children are the workspaces.
const bar = app.slice(app.indexOf('function OmarchyBar'))
const body = bar.slice(0, bar.indexOf('\n}\n'))
check('the bar is still a tablist', body.includes('accessibilityRole="tablist"'))
check('the bar still maps the workspaces', body.includes('WORKSPACES.map'))
check('the bar has no button beside the tabs', !body.includes('accessibilityRole="button"'))
check('nothing is pushed to the right any more', !body.includes("marginLeft: 'auto'"))

// What the criteria say must survive: the badges and the active underline.
check('badges still drawn', body.includes('agentsWaiting') && body.includes('asks'))
check('active workspace still underlined', body.includes('palette.accent'))

check('DESIGN.md no longer describes a tray', !/tray/i.test(design))

done()
