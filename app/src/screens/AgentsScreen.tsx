import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, View } from 'react-native'

import { useConnection } from '../state/ConnectionContext'
import type { AgentSession } from '../api/client'
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
  const caps = (hello?.capabilities?.agents ?? null) as
    | { enabled?: boolean; adapters?: string[]; write?: string | null }
    | null

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
            Source, tool output, whatever crossed a command's result — all of it would cross to this phone. Enable it
            deliberately on the desktop:
          </Body>
          <Body style={{ marginTop: space.md }}>omarchy-connect agent enable</Body>
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

      {caps?.write === null ? (
        <Body tone={palette.muted} style={{ textAlign: 'center' }}>
          Reading only — this desktop cannot yet be typed into
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
        `${session.agent} · ${ago(session.lastActivity)}${session.via === 'scan' ? ' · found by scan' : ''}`,
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
