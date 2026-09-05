import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native'
import { Feather } from '@expo/vector-icons'

import { useAgents, useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentCapabilities, AgentJob, AgentSession, AgentState, AgentWorker } from '../api/client'
import { Card, CardHeader, Empty, Hint, IconButton, Label, ListRow, Notice, Pill, Screen, ScreenHeader } from '../ui/kit'
import { Limits, StatusLine, inPane, tokens, until } from '../ui/agentkit'
import { AgentChatScreen } from './AgentChatScreen'
import { AgentLaunchScreen } from './AgentLaunchScreen'
import { AgentWorkerScreen } from './AgentWorkerScreen'
import { ago } from '../lib/format'
import { space, touch } from '../theme'

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

  /* Switched off on the desktop: the card is still drawn, dimmed, with the
     one command that fills it. Nothing is asked for while it is off. */
  if (caps && caps.enabled === false) {
    return (
      <Screen>
        <ScreenHeader title="Agents" />
        <Card>
          <CardHeader icon="terminal" title="Sessions" subtitle="off on the desktop" tone={palette.muted} />
          <Hint icon="power">Switch on with omarchy-connect agent enable</Hint>
        </Card>
      </Screen>
    )
  }

  /* Background agents already open as a session are that session's row. */
  const detached = agentJobs.filter((job) => !jobOpen[job.id])
  const waiting = sorted.filter((s) => s.state === 'waiting').length
  const liveJobs = detached.filter((job) => job.live !== false).length

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={palette.muted} />}>
      <ScreenHeader
        title="Agents"
        right={
          <>
            <IconButton icon="refresh-cw" label="Refresh" onPress={() => void load()} loading={refreshing} />
            {caps?.history ? <IconButton icon="plus" label="New agent" tone={palette.accent} onPress={() => setLaunching(true)} /> : null}
          </>
        }
      />

      {/* What the plan has left. First, because it is the number that decides
          whether starting something long is a good idea, and that decision is
          made before anything on this screen is opened. */}
      {agentLimits?.limits?.length ? (
        <Card>
          <CardHeader icon="activity" title="Usage" subtitle={nearestReset(agentLimits.limits)} />
          <Limits limits={agentLimits} />
        </Card>
      ) : null}

      <Card>
        <CardHeader
          icon="terminal"
          title="Sessions"
          subtitle={sorted.length ? `${sorted.length} running · ${waiting} waiting` : null}
        />
        {/* Asking the desktop for its sessions failed. Without this the screen
            showed an empty list, which is what a quiet desktop looks like too. */}
        <Notice error={agentsError} tone="warning" action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void load() }} />
        {sorted.length ? (
          sorted.map((session, i) => (
            <SessionRow
              key={session.id}
              session={session}
              last={i === sorted.length - 1}
              onPress={() => setOpenId(session.id)}
              onWorker={(worker) => setOpenWorker({ id: session.id, worker })}
            />
          ))
        ) : refreshing && !agentsError ? (
          <ActivityIndicator color={palette.muted} style={{ paddingVertical: space.xl }} />
        ) : agentsError ? null : (
          <Empty icon="terminal" text={caps?.history ? 'No sessions · Start one on the desktop or tap +' : 'No sessions · Start one on the desktop'} />
        )}
        {caps?.enabled && !caps.write ? (
          <Hint icon="eye" style={{ marginTop: space.md }}>
            Read only · no multiplexer or wtype on the desktop
          </Hint>
        ) : null}
        {/* Background agents are read-only by their nature rather than for want
            of a multiplexer, so the line that sends people to `agent run` is
            only worth showing when some session it would actually help is on
            screen. */}
        {caps?.write && sorted.some((s) => !s.writable && !s.job) ? (
          <Hint icon="eye" style={{ marginTop: space.md }}>
            Read only · Start sessions with omarchy-connect agent run
          </Hint>
        ) : null}
      </Card>

      {/* An agent with no terminal. Nothing on the desktop is drawing these —
          no pane, no window, no bar — so this is the only screen anywhere that
          says what they are doing. */}
      {detached.length ? (
        <Card>
          <CardHeader
            icon="moon"
            title="In the background"
            subtitle={liveJobs ? `${liveJobs} running · no terminal` : 'recent results'}
          />
          {detached.map((job, i) => (
            <JobRow key={job.id} job={job} last={i === detached.length - 1} />
          ))}
        </Card>
      ) : null}
    </Screen>
  )
}

/**
 * The card's subtitle: which window turns over next, and when. The one thing
 * about the plan worth saying before the rows say the rest.
 */
function nearestReset(limits: { label: string; resetsAt: number | null; stale?: boolean }[]): string | null {
  const soonest = limits
    .filter((limit) => !limit.stale && limit.resetsAt)
    .sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0))[0]
  if (!soonest) return limits.some((limit) => limit.stale) ? 'measured earlier' : null
  const gap = until(soonest.resetsAt)
  return gap ? `${soonest.label} resets in ${gap}` : null
}

/** The last path segment, for a session the CLI has not named yet. */
function basename(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** One state, one word, one colour: what the pill on a row says. */
function stateOf(state: AgentState, palette: ReturnType<typeof usePalette>): { label: string; tone: string } {
  switch (state) {
    case 'working':
      return { label: 'working', tone: palette.green }
    case 'waiting':
      return { label: 'waiting', tone: palette.orange }
    case 'starting':
      return { label: 'starting', tone: palette.cyan }
    case 'gone':
      return { label: 'done', tone: palette.muted }
    default:
      return { label: 'idle', tone: palette.light_foreground }
  }
}

function SessionRow({
  session,
  last,
  onPress,
  onWorker,
}: {
  session: AgentSession
  last: boolean
  onPress: () => void
  onWorker: (worker: AgentWorker) => void
}) {
  const palette = usePalette()
  const state = stateOf(session.state, palette)
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
  const working = workers.filter((w) => w.running).length
  const readOnly = !session.job && !inPane(session) && session.writable !== 'wtype'

  // What it is working on, in the agent's own words, beats what it last did:
  // a row that says "Pushing background-agent state live" is one you can act
  // on, and "Bash grep -rn router src" is not. So the transcript's last line
  // is never shown here — when the agent has said nothing about itself, the
  // row says how long ago it moved instead.
  const doing =
    session.state === 'waiting'
      ? session.prompt || 'Waiting for an answer'
      : session.state === 'starting'
        ? 'Starting'
        : (session.state === 'working' && session.tasks?.active) || session.job?.detail || ago(session.lastActivity)

  return (
    <View
      style={{
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: palette.lighter_background,
      }}
    >
      <ListRow
        title={session.title || basename(session.cwd) || session.agent}
        // Which road in decides whether the composer is a text field or an
        // apology, so a row that cannot be typed into says so before it is opened.
        subtitle={readOnly ? `${doing} · read only` : doing}
        right={<Pill label={state.label} tone={state.tone} />}
        onPress={onPress}
        last
      />
      {/* The desktop's own status line, under the row it belongs to. On a list
          of six sessions this is what tells them apart: which model, and which
          of them is about to run out of context. */}
      {session.vitals ? (
        <View style={{ marginTop: -space.xs, marginBottom: space.sm }}>
          <StatusLine vitals={session.vitals} dense />
        </View>
      ) : null}

      {/* The workers this session has out, under the session they belong to.
          Nested rather than listed beside it, because a worker is not a
          session: it has no terminal, it is never resumed, and a phone that
          drew it as a peer would be showing four rows for one conversation. */}
      {workers.length ? (
        <View style={{ marginBottom: space.xs }}>
          <Fold
            open={unfolded}
            onPress={() => setUnfolded((was) => !was)}
            label={working ? `${working} working of ${workers.length}` : `${workers.length} worker${workers.length > 1 ? 's' : ''} · all done`}
          />
          {unfolded ? (
            <View style={{ paddingLeft: space.md }}>
              {workers.map((worker, i) => (
                <WorkerRow key={worker.id} worker={worker} last={i === workers.length - 1} onPress={() => onWorker(worker)} />
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
function WorkerRow({ worker, last, onPress }: { worker: AgentWorker; last: boolean; onPress: () => void }) {
  const palette = usePalette()
  return (
    <ListRow
      title={worker.description || worker.type || worker.id}
      subtitle={worker.preview || (worker.running ? 'Just started' : `Finished ${ago(worker.updatedAt)}`)}
      right={<Pill label={worker.running ? 'working' : 'done'} tone={worker.running ? palette.green : palette.light_foreground} />}
      chevron
      onPress={onPress}
      last={last}
    />
  )
}

/**
 * One background agent.
 *
 * `detail` is the sentence the CLI wrote about what the job is doing right
 * now, and it is the whole point of the row: a detached agent has no screen
 * anywhere, so this line is the only running commentary it has.
 */
function JobRow({ job, last }: { job: AgentJob; last: boolean }) {
  const palette = usePalette()
  // The state file outlives the process, so `working` on a dead job is
  // history, not status — a daemon that knows says so, and the row goes grey
  // rather than keep a pulse going for an agent that is not there.
  const live = job.live !== false
  const tone = !live
    ? palette.light_foreground
    : job.state === 'working'
      ? palette.green
      : job.state === 'waiting' || job.state === 'blocked'
        ? palette.orange
        : palette.light_foreground
  return (
    <ListRow
      title={job.name}
      subtitle={job.detail || `${tokens(job.tokens)} tokens · ${ago(job.updatedAt)}`}
      right={<Pill label={live ? job.state : 'ended'} tone={tone} />}
      last={last}
    />
  )
}

/**
 * A disclosure line: a chevron and a count, tappable across its whole width.
 * Belongs in the kit once a second screen folds something.
 */
function Fold({ open, label, onPress }: { open: boolean; label: string; onPress: () => void }) {
  const palette = usePalette()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        minHeight: touch - 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Feather name={open ? 'chevron-down' : 'chevron-right'} size={14} color={palette.light_foreground} />
      <Label>{label}</Label>
    </Pressable>
  )
}
