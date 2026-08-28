import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, View } from 'react-native'
import { Feather } from '@expo/vector-icons'

import { useConnection } from '../state/ConnectionContext'
import type { AgentCapabilities, AgentJob, AgentSession } from '../api/client'
import { Body, Caps, Card, CardHeader, Divider, Empty, ListRow, Screen, StatusDot } from '../ui/kit'
import { Limits, StatusLine, tokens } from '../ui/agentkit'
import { AgentChatScreen } from './AgentChatScreen'
import { AgentLaunchScreen } from './AgentLaunchScreen'
import { ago } from '../lib/format'
import { space } from '../theme'

/**
 * The coding agents running on the desktop, and what they are stuck on.
 *
 * The list is driven by events rather than polling — a `waiting` agent has to
 * reach the phone while it is on another screen entirely — and a pull-to-
 * refresh asks for the authoritative answer.
 *
 * Above the list are the two things that are true whether or not anything is
 * running: how much of the plan is left, and the background agents nothing on
 * the desktop is showing. Both are here rather than folded away because they
 * change what you do next — the first decides whether to start something long,
 * and the second is the only place a `--bg` session appears at all.
 */
export function AgentsScreen({ open: requested, onOpened }: { open?: string | null; onOpened?: () => void } = {}) {
  const { agents, agentLimits, agentJobs, refreshAgents, palette, status, hello, call } = useConnection()
  const [openId, setOpenId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Which background agents are also live sessions. The list itself arrives as
  // an event; this is the one part of the answer only a round trip has, and it
  // changes about as often as a session opens.
  const [jobOpen, setJobOpen] = useState<Record<string, string>>({})

  /**
   * A session asked for from outside — the notification saying this agent is
   * waiting. Remembered rather than acted on: on a cold start the list has not
   * arrived yet, and the chat opens the moment the session it names turns up
   * in it.
   */
  useEffect(() => {
    if (!requested) return
    setOpenId(requested)
    setLaunching(false)
    onOpened?.()
  }, [requested, onOpened])

  const connected = status === 'connected'
  const caps = (hello?.capabilities?.agents ?? null) as AgentCapabilities | null

  const load = useCallback(async () => {
    setRefreshing(true)
    await refreshAgents()
    // The jobs themselves are pushed; which of them the phone can walk into is
    // not, so that half is asked for.
    if (caps?.jobs) {
      try {
        const res = await call<{ open: Record<string, string> }>('agents.jobs', {})
        setJobOpen(res.open || {})
      } catch {
        setJobOpen({})
      }
    }
    setRefreshing(false)
  }, [call, caps?.jobs, refreshAgents])

  useEffect(() => {
    if (connected && caps?.enabled) void load()
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
  if (launching) {
    return (
      <AgentLaunchScreen
        onBack={() => setLaunching(false)}
        onOpen={(id) => {
          setLaunching(false)
          setOpenId(id)
        }}
      />
    )
  }

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

  /* Background agents already open as a session are that session's row. */
  const detached = agentJobs.filter((job) => !jobOpen[job.id])

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={palette.muted} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
        <Caps style={{ flex: 1 }}>Agents</Caps>
        {caps?.history ? (
          <Pressable onPress={() => setLaunching(true)} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Feather name="plus-circle" size={18} color={palette.accent} />
          </Pressable>
        ) : null}
      </View>

      {/* What the plan has left. First, because it is the number that decides
          whether starting something long is a good idea, and that decision is
          made before anything on this screen is opened. */}
      {agentLimits?.limits?.length ? (
        <Card>
          <CardHeader
            icon="activity"
            title="Usage"
            subtitle={agentLimits.limits.find((l) => l.active)?.label ?? 'what the plan has left'}
          />
          <Limits limits={agentLimits} />
        </Card>
      ) : null}

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

      {/* An agent with no terminal. Nothing on the desktop is drawing these —
          no pane, no window, no bar — so this is the only screen anywhere that
          says what they are doing. */}
      {detached.length ? (
        <Card>
          <CardHeader icon="moon" title="In the background" subtitle={`${detached.length} with no terminal`} />
          {detached.map((job, i) => (
            <View key={job.id}>
              {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
              <JobRow job={job} />
            </View>
          ))}
        </Card>
      ) : null}

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
    <View>
      <ListRow
        title={session.title}
        tone={session.state === 'waiting' ? palette.bright_foreground : undefined}
        subtitle={[
          // What it is working on, in the agent's own words, beats what it
          // last did: a row that says "Pushing background-agent state live" is
          // one you can act on, and "Bash grep -rn router src" is not.
          session.state === 'waiting'
            ? session.prompt || 'waiting for an answer'
            : (session.state === 'working' && session.tasks?.active) || session.job?.detail || session.preview,
          [
            // Once the title is the conversation's own name, the project it is
            // in stops being obvious — so it is said here instead.
            session.project,
            session.tasks?.total ? `${session.tasks.done}/${session.tasks.total} done` : null,
            ago(session.lastActivity),
            session.job ? 'background' : session.via === 'scan' ? 'found by scan' : null,
            // Which road in, because it decides whether the composer is a text
            // field or an apology — and `wtype` is worth knowing before you open it.
            session.writable === 'tmux'
              ? 'answerable'
              : session.writable === 'wtype'
                ? 'answerable · steals focus'
                : 'read only',
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
      {/* The desktop's own status line, under the row it belongs to. On a list
          of six sessions this is what tells them apart: which model, and which
          of them is about to run out of context. */}
      {session.vitals ? (
        <View style={{ marginTop: -space.xs, marginBottom: space.xs, paddingRight: space.xs }}>
          <StatusLine vitals={session.vitals} dense />
        </View>
      ) : null}
    </View>
  )
}

/**
 * One background agent.
 *
 * `detail` is the sentence the CLI wrote about what the job is doing right
 * now, and it is the whole point of the row: a detached agent has no screen
 * anywhere, so this line is the only running commentary it has.
 */
function JobRow({ job }: { job: AgentJob }) {
  const { palette } = useConnection()
  const tone = job.state === 'working' ? palette.green : job.state === 'waiting' ? palette.orange : palette.muted
  return (
    <ListRow
      title={job.name}
      subtitle={[job.detail, [`${tokens(job.tokens)} tokens`, ago(job.updatedAt)].filter(Boolean).join(' · ')]
        .filter(Boolean)
        .join('\n')}
      right={
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <StatusDot tone={tone} pulse={job.state === 'working'} />
          <Caps tone={tone}>{job.state}</Caps>
        </View>
      }
    />
  )
}
