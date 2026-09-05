import React from 'react'
import { View } from 'react-native'

import { problem, type Problem } from '../lib/errors'
import { usePalette } from '../state/ConnectionContext'
import { Button, Hint, IconBox, Notice, Title } from './kit'
import { space } from '../theme'

/**
 * The floor under the screens.
 *
 * There was no `componentDidCatch` anywhere in this app, which meant exactly
 * what it sounds like: one throw inside one screen's render — a field the
 * desktop stopped sending, a list item with a shape nobody expected — unmounted
 * the whole tree and left a blank window that only a force-stop recovers from.
 * The link underneath is still up in that state, the socket is still connected,
 * the service is still running; the only thing gone is the picture.
 *
 * So a throw during render stops here instead. What is shown is the same
 * `Notice` the screens use — one sentence, the trace behind a tap — plus the
 * way back, because a crash in one tab says nothing about the other four.
 *
 * `resetKey` is that way back's other half: switching tabs changes it, and a
 * boundary whose key has moved is a boundary looking at a different screen,
 * so it clears itself rather than holding the last screen's wreckage.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: unknown },
  { failure: Problem | null }
> {
  state: { failure: Problem | null } = { failure: null }

  static getDerivedStateFromError(error: unknown) {
    return { failure: problem(error, 'this screen could not be drawn') }
  }

  componentDidCatch(error: unknown) {
    // Still logged, because the phone is where this gets debugged from and
    // `adb logcat` is the only channel out of a device nobody is holding.
    console.error('[omarchy] render crashed', error)
  }

  componentDidUpdate(previous: { children: React.ReactNode; resetKey?: unknown }) {
    if (this.state.failure && previous.resetKey !== this.props.resetKey) this.setState({ failure: null })
  }

  render() {
    if (!this.state.failure) return this.props.children
    return <Crashed failure={this.state.failure} onRetry={() => this.setState({ failure: null })} />
  }
}

/** The screen that is shown instead of the one that threw. */
function Crashed({ failure, onRetry }: { failure: Problem; onRetry: () => void }) {
  const p = usePalette()
  return (
    <View style={{ flex: 1, backgroundColor: p.background, justifyContent: 'center', padding: space.lg }}>
      <View style={{ marginBottom: space.lg }}>
        <IconBox name="alert-triangle" tone={p.orange} size={40} />
      </View>
      <Title style={{ marginBottom: space.xs }}>This screen stopped</Title>
      <Hint style={{ marginBottom: space.lg }}>Your desktop link is fine · Switch tabs or try again</Hint>
      <Notice error={failure.detail ? `${failure.message}\n${failure.detail}` : failure.message} />
      <Button label="Try again" icon="refresh-cw" onPress={onRetry} />
    </View>
  )
}
