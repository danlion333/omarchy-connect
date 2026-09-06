import React from 'react'

import { Empty, Screen, ScreenHeader } from '../ui/kit'

/**
 * Workspace 3: the phone as a keyboard for the desktop's terminal.
 *
 * A stub for now — the shell needs five workspaces before the screen that
 * fills this one exists. What lands here is `input.text` and `input.key`
 * against the focused window, with the local history of what was sent; there
 * is no output readback from the desktop, so nothing on this screen will ever
 * claim to show what the terminal replied.
 */
export function TerminalScreen() {
  return (
    <Screen>
      <ScreenHeader title="Terminal" sub="your keyboard, their screen" />
      <Empty icon="terminal" text="Coming up" />
    </Screen>
  )
}
