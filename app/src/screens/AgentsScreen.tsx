import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, View } from 'react-native'

import { useConnection } from '../state/ConnectionContext'
import type { AgentCapabilities, AgentSession } from '../api/client'
import { Body, Caps, Card, CardHeader, Divider, Empty, ListRow, Screen, StatusDot } from '../ui/kit'
import { AgentChatScreen } from './AgentChatScreen'
import { ago } from '../lib/format'
import { space } from '../theme'

/**
 * The coding agents running on the desktop, and what they are stuck on.
 *
 * The list is driven by events rather than polling — a `waiting` agent has to
 * reach the phone while it is on another screen entirely — and a pull-to-
 * refresh asks for the authoritative answer.
 */
export function AgentsScreen() {
  const { agents, refreshAgents, palette, status, hello } = useConnection()
  const [openId, setOpenId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const connected = status === 'connected'
  const caps = (hello?.capabilities?.agents ?? null) as AgentCapabilities | null

  const load = useCallback(async () => {
    setRefreshing(true)
    await refreshAgents()
    setRefreshing(false)
  }, [refreshAgents])

  useEffect(() => {
    if (connected && caps?.enabled) load()
  }, [connected, caps?.enabled, load])

  /* Whoever is blocked comes first; everyone else by how recently they moved. */
  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        if ((a.state === 'waiting') !== (b.state === 'waiting')) return a.state === 'waiting' ? -1 : 1
        return b.lastActivity - a.lastActivity
      }),
    [agents],
  )

  const open = sorted.find((s) => s.id === openId)
  if (open) return <AgentChatScreen session={open} onBack={() => setOpenId(null)} />

  if (caps && caps.enabled === false) {
    return (
      <Screen>
        <Caps style={{ marginBottom: space.md }}>Agents</Caps>
        <Card>
          <CardHeader icon="terminal" title="Turned off on the desktop" subtitle="reading an agent is reading everything it saw" />
          <Body tone={palette.muted}>
            Source, tool output, whatever crossed a command's result — all of it would cross to this phone, and this
            phone could type back into an agent that will run what it is told. Enable it deliberately on the desktop:
          </Body>
          <Body style={{ marginTop: space.md }}>omarchy-connect agent enable</Body>
          <Body tone={palette.muted} style={{ marginTop: space.md }}>
            Or flip the switch under Coding agents on the desktop panel — this screen fills the moment it does.
          </Body>
        </Card>
      </Screen>
    )
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={palette.muted} />}>
      <Caps style={{ marginBottom: space.md }}>Agents</Caps>

      <Card>
        <CardHeader
          icon="terminal"
          title="Sessions"
          subtitle={
            sorted.length
              ? `${sorted.length} running · ${sorted.filter((s) => s.state === 'waiting').length} waiting`
              : 'nothing running'
          }
        />
        {sorted.length ? (
          sorted.map((session, i) => (
            <View key={session.id}>
              {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
              <SessionRow session={session} onPress={() => setOpenId(session.id)} />
            </View>
          ))
        ) : (
          <Empty icon="terminal" text="No coding agent is running on the desktop" />
        )}
      </Card>

      {caps?.enabled && !caps.write ? (
        <Body tone={palette.muted} style={{ textAlign: 'center' }}>
          Reading only — that desktop has neither tmux nor wtype, so nothing there can type into a terminal
        </Body>
      ) : null}
      {caps?.write && sorted.some((s) => !s.writable) ? (
        <Body tone={palette.muted} style={{ textAlign: 'center' }}>
          A session with no dot beside it is not in a terminal this desktop can reach — start those with{' '}
          omarchy-connect agent run
        </Body>
      ) : null}
    </Screen>
  )
}

function SessionRow({ session, onPress }: { session: AgentSession; onPress: () => void }) {
  const { palette } = useConnection()
  const tone =
    session.state === 'waiting' ? palette.orange : session.state === 'working' ? palette.green : palette.muted

  return (
    <ListRow
      title={session.title}
      tone={session.state === 'waiting' ? palette.bright_foreground : undefined}
      subtitle={[
        session.state === 'waiting' ? session.prompt || 'waiting for an answer' : session.preview,
        [
          session.agent,
          ago(session.lastActivity),
          session.via === 'scan' ? 'found by scan' : null,
          // Which road in, because it decides whether the composer is a text
          // field or an apology — and `wtype` is worth knowing before you open it.
          session.writable === 'tmux' ? 'answerable' : session.writable === 'wtype' ? 'answerable · steals focus' : 'read only',
        ]
          .filter(Boolean)
          .join(' · '),
      ]
        .filter(Boolean)
        .join('\n')}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <StatusDot tone={tone} pulse={session.state === 'working'} />
          <Caps tone={tone}>{session.state}</Caps>
        </View>
      }
      onPress={onPress}
    />
  )
}
