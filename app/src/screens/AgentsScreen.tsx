import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'

import { useAgents, useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentCapabilities, AgentJob, AgentSession, AgentWorker } from '../api/client'
import { Body, Caps, Card, CardHeader, Divider, Empty, ListRow, Notice, Screen, StatusDot } from '../ui/kit'
import { Limits, StatusLine, inPane, tokens } from '../ui/agentkit'
import { AgentChatScreen } from './AgentChatScreen'
import { AgentLaunchScreen } from './AgentLaunchScreen'
import { AgentWorkerScreen } from './AgentWorkerScreen'
import { ago } from '../lib/format'
import { font, size, space } from '../theme'

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
  const { refreshAgents, refreshAgentJobs, palette, status, hello } = useConnection()
  const { agents, agentLimits, agentJobs, agentsError } = useAgents()
  const [openId, setOpenId] = useState<string | null>(null)
  /**
   * A worker being read, and whose session it belongs to.
   *
   * Held here rather than inside the chat because both roads into a worker end
   * up on the same screen: the nested row on this list, and the `Agent` chip in
   * the parent's chat whose `ref` names it.
   */
  const [openWorker, setOpenWorker] = useState<{ id: string; worker: AgentWorker } | null>(null)
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
    // Changes are pushed, but a phone that has just connected has missed every
    // change there ever was — an event stream is not a starting state.
    if (caps?.jobs) setJobOpen(await refreshAgentJobs())
    setRefreshing(false)
  }, [caps?.jobs, refreshAgentJobs, refreshAgents])

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

  /* A worker read from its own session — from the list, or from the chip. */
  const workerHost = openWorker ? sorted.find((s) => s.id === openWorker.id) : undefined
  if (openWorker && workerHost) {
    // The row that opened it is a snapshot; this is the same worker as the
    // desktop last described it, so a worker that stops while it is being read
    // says so.
    const current = workerHost.workers?.find((w) => w.id === openWorker.worker.id) ?? openWorker.worker
    return (
      <AgentWorkerScreen session={workerHost} worker={current} onBack={() => setOpenWorker(null)} />
    )
  }

  const open = sorted.find((s) => s.id === openId)
  if (open) {
    return (
      <AgentChatScreen
        session={open}
        onBack={() => setOpenId(null)}
        onWorker={(worker) => setOpenWorker({ id: open.id, worker })}
      />
    )
  }
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

      {/* Asking the desktop for its sessions failed. Without this the screen
          showed an empty list, which is what a quiet desktop looks like too. */}
      <Notice error={agentsError} tone="warning" />

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
              <SessionRow
                session={session}
                onPress={() => setOpenId(session.id)}
                onWorker={(worker) => setOpenWorker({ id: session.id, worker })}
              />
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
          <CardHeader
            icon="moon"
            title="In the background"
            subtitle={
              detached.some((job) => job.live !== false)
                ? `${detached.filter((job) => job.live !== false).length} running · no terminal`
                : 'nothing running — recent results'
            }
          />
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
          Reading only — that desktop has no multiplexer and no wtype, so nothing there can type into a terminal
        </Body>
      ) : null}
      {/* Background agents are read-only by their nature rather than for want
          of a multiplexer, so the line that sends people to `agent run` is
          only worth showing when some session it would actually help is on
          screen. */}
      {caps?.write && sorted.some((s) => !s.writable && !s.job) ? (
        <Body tone={palette.muted} style={{ textAlign: 'center' }}>
          A session with no dot beside it is not in a terminal this desktop can reach — start those with{' '}
          omarchy-connect agent run
        </Body>
      ) : null}
    </Screen>
  )
}

function SessionRow({
  session,
  onPress,
  onWorker,
}: {
  session: AgentSession
  onPress: () => void
  onWorker: (worker: AgentWorker) => void
}) {
  const palette = usePalette()
  const tone =
    session.state === 'waiting' ? palette.orange : session.state === 'working' ? palette.green : palette.muted
  /**
   * Whether the workers are showing.
   *
   * Folded by default and folded again by every re-render of the list? No —
   * this is per-row state and the row survives, so a fan-out opened once stays
   * open while it is watched. Closed to begin with because the common shape of
   * this screen is several sessions and no fan-out at all, and a list that
   * unfolds itself is a list nobody can find their session on.
   */
  const [unfolded, setUnfolded] = useState(false)
  const workers = session.workers ?? []

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
            : session.state === 'starting'
              ? session.preview || 'just started — nothing on disk yet'
              : (session.state === 'working' && session.tasks?.active) || session.job?.detail || session.preview,
          [
            // Once the title is the conversation's own name, the project it is
            // in stops being obvious — so it is said here instead.
            session.project,
            session.tasks?.total ? `${session.tasks.done}/${session.tasks.total} done` : null,
            // A fan-out is invisible in the transcript, so this row is the
            // only place the phone can say the session is more than one agent.
            // The count still stands for a desktop whose CLI keeps no
            // per-worker files; where it does, the rows below say who they are.
            session.subagents ? `${session.subagents} subagent${session.subagents > 1 ? 's' : ''}` : null,
            ago(session.lastActivity),
            session.job ? 'background' : session.via === 'scan' ? 'found by scan' : null,
            // Which road in, because it decides whether the composer is a text
            // field or an apology — and `wtype` is worth knowing before you open it.
            inPane(session)
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

      {/* The workers this session has out, under the session they belong to.
          Nested rather than listed beside it, because a worker is not a
          session: it has no terminal, it is never resumed, and a phone that
          drew it as a peer would be showing four rows for one conversation. */}
      {workers.length ? (
        <View style={{ marginBottom: space.xs }}>
          <Pressable
            onPress={() => setUnfolded((was) => !was)}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              paddingVertical: 2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Feather name={unfolded ? 'chevron-down' : 'chevron-right'} size={12} color={palette.muted} />
            <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }}>
              {workers.filter((w) => w.running).length
                ? `${workers.filter((w) => w.running).length} working of ${workers.length}`
                : `${workers.length} worker${workers.length > 1 ? 's' : ''} · all done`}
            </Text>
          </Pressable>

          {unfolded ? (
            <View style={{ marginTop: 2, gap: 1 }}>
              {workers.map((worker) => (
                <WorkerRow key={worker.id} worker={worker} onPress={() => onWorker(worker)} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/**
 * One worker, under the session that sent it off.
 *
 * The description is what the caller wrote when it spawned this one, and it is
 * the whole reason the row exists — "Protocol + docs for agents" is a thing you
 * can decide to open, and "subagent 2 of 3" is not. Under it is the last thing
 * the worker actually said, which is the same running commentary a session row
 * carries and read the same way.
 *
 * A worker that has finished stays here rather than disappearing at the moment
 * it stops: what it went and found out is the point, and that is worth more
 * once it is done than while it is working.
 */
function WorkerRow({ worker, onPress }: { worker: AgentWorker; onPress: () => void }) {
  const palette = usePalette()
  const tone = worker.running ? palette.green : palette.muted

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.xs,
        paddingLeft: space.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <StatusDot tone={tone} pulse={worker.running} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.label }} numberOfLines={1}>
          {worker.description || worker.type || worker.id}
        </Text>
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.micro }} numberOfLines={1}>
          {[worker.type, worker.preview || (worker.running ? 'just started' : 'finished'), ago(worker.updatedAt)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <Feather name="chevron-right" size={14} color={palette.muted} />
    </Pressable>
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
  const palette = usePalette()
  // The state file outlives the process, so `working` on a dead job is
  // history, not status — a daemon that knows says so, and the row goes grey
  // rather than keep a pulse going for an agent that is not there.
  const live = job.live !== false
  const tone = !live
    ? palette.muted
    : job.state === 'working'
      ? palette.green
      : job.state === 'waiting' || job.state === 'blocked'
        ? palette.orange
        : palette.muted
  return (
    <ListRow
      title={job.name}
      subtitle={[job.detail, [`${tokens(job.tokens)} tokens`, ago(job.updatedAt)].filter(Boolean).join(' · ')]
        .filter(Boolean)
        .join('\n')}
      right={
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <StatusDot tone={tone} pulse={live && job.state === 'working'} />
          <Caps tone={tone}>{live ? job.state : 'ended'}</Caps>
        </View>
      }
    />
  )
}
