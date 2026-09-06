import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native'

import { Feather } from '@expo/vector-icons'

import { useAgents, useConnection, usePalette } from '../state/ConnectionContext'
import type { AgentCapabilities, AgentJob, AgentLimits, AgentSession, AgentState, AgentWorker } from '../api/client'
import {
  Button,
  Buttons,
  Card,
  CardHeader,
  Code,
  Empty,
  Hint,
  IconButton,
  Label,
  ListRow,
  Notice,
  Pill,
  Screen,
  ScreenHeader,
  useToast,
} from '../ui/kit'
import { Limits, StatusLine, inPane, tokens, until } from '../ui/agentkit'
import { AgentChatScreen } from './AgentChatScreen'
import { AgentLaunchScreen } from './AgentLaunchScreen'
import { AgentWorkerScreen } from './AgentWorkerScreen'
import { ago } from '../lib/format'
import { alpha, space, touch } from '../theme'

/**
 * The coding agents running on the desktop, and what they are stuck on.
 *
 * The screen is ordered by what stops you: whoever is blocked gets a card of
 * their own at the top, with the command it wants to run and the two buttons
 * that answer it, so the common case — an agent waiting on a `git push` while
 * you are on a bus — is one tap and never opens a conversation. Under it the
 * sessions, the background agents nothing on the desktop is drawing, and last
 * the plan's headroom.
 *
 * The list is driven by events rather than polling — a `waiting` agent has to
 * reach the phone while it is on another screen entirely — and a pull-to-
 * refresh asks for the authoritative answer.
 */
export function AgentsScreen({ open: requested, onOpened }: { open?: string | null; onOpened?: () => void } = {}) {
  const { refreshAgents, refreshAgentJobs, palette, status, hello, call } = useConnection()
  const { agents, agentLimits, agentJobs, agentsError } = useAgents()
  const toast = useToast()
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

  /**
   * The one key the desktop's numbered list always has in the same place.
   *
   * This is the chat's own permission card, moved up a screen: the terminal is
   * sitting on a list whose first entry is yes and whose escape is no, so
   * `agents.key` with `1` or `Escape` is the whole answer. Nothing else about
   * a prompt can be answered from a list row — an option in the middle, or a
   * multiple-choice question out of the transcript, needs the block it came
   * from — and those cards open the chat instead.
   */
  const send = useCallback(
    async (session: AgentSession, key: '1' | 'Escape') => {
      await call('agents.key', { id: session.id, key })
      toast({
        value: key === '1' ? 'allowed' : 'denied',
        hint: 'the agent carries on',
        icon: key === '1' ? 'check' : 'x',
      })
    },
    [call, toast],
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
        <ScreenHeader title="Agents" sub="off on the desktop" dot="off" />
        <Card dim>
          <CardHeader icon="terminal" title="Sessions" subtitle="off on the desktop" tone={palette.muted} />
          <Hint icon="power">Switch on with omarchy-connect agent enable</Hint>
        </Card>
      </Screen>
    )
  }

  /* Background agents already open as a session are that session's row. */
  const detached = agentJobs.filter((job) => !jobOpen[job.id])
  const asking = sorted.filter((s) => s.state === 'waiting' && s.prompt)
  const waiting = sorted.filter((s) => s.state === 'waiting').length
  const liveJobs = detached.filter((job) => job.live !== false).length
  const canLaunch = Boolean(caps?.history)

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={palette.muted} />}>
      <ScreenHeader
        title="Agents"
        // One line, and the half of it that matters is the count of agents
        // stopped on something: orange while any of them is, and the dot is
        // the only colour `ScreenHeader` has to say it with.
        status={{
          label: `${sorted.length} session${sorted.length === 1 ? '' : 's'} · ${waiting ? `${waiting} waiting` : 'none waiting'}`,
          tone: waiting ? palette.orange : palette.muted,
        }}
        right={
          <>
            <IconButton icon="refresh-cw" label="Refresh" onPress={() => void load()} loading={refreshing} />
            {canLaunch ? <IconButton icon="plus" label="New agent" tone={palette.accent} onPress={() => setLaunching(true)} /> : null}
          </>
        }
      />

      {/* Whoever is blocked, one card each, above everything. A permission is
          answered here; anything else says what it is and opens the chat. */}
      {asking.map((session) => (
        <AskCard
          key={session.id}
          session={session}
          onSend={(key) => send(session, key)}
          onOpen={() => setOpenId(session.id)}
        />
      ))}

      <Card>
        <CardHeader icon="terminal" title="Sessions" />
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
          <Empty
            icon="terminal"
            text="No sessions · Start one from the desktop with omarchy-connect agent"
            action={canLaunch ? { label: 'Start one', icon: 'plus', onPress: () => setLaunching(true) } : null}
          />
        )}
        {caps?.enabled && !caps.write ? (
          <Hint icon="eye">Read only · no multiplexer or wtype on the desktop</Hint>
        ) : null}
        {/* Background agents are read-only by their nature rather than for want
            of a multiplexer, so the line that sends people to `agent run` is
            only worth showing when some session it would actually help is on
            screen. */}
        {caps?.write && sorted.some((s) => !s.writable && !s.job) ? (
          <Hint icon="eye">Read only · Start sessions with omarchy-connect agent run</Hint>
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

      {/* What the plan has left. Last, because it is the one card here that is
          true whether or not anything is running — and dimmed rather than
          dropped when the desktop could not measure it. */}
      <UsageCard limits={agentLimits} />
    </Screen>
  )
}

/* ── the ask ─────────────────────────────────────────────────────────── */

/**
 * A permission prompt, taken apart into the two things the card draws.
 *
 * The desktop writes one sentence — "Bash needs your permission: git push
 * origin main" — and a phone has room for the tool as a title and the command
 * on its own line under it. A prompt that is not that shape is not a
 * permission at all (a numbered question out of the transcript, most often),
 * and the card says so by not offering an answer it cannot give.
 */
export function readAsk(prompt: string | null | undefined): { tool: string; what: string | null } | null {
  const line = String(prompt || '').trim()
  const match = /^(.+?)\s+needs your permission(?::\s*(.*))?$/s.exec(line)
  if (!match) return null
  return { tool: match[1].trim(), what: match[2]?.trim() || null }
}

/** How long it has been stopped, in the mock's words: `3m`, `1h 12m`. */
function waited(at: number | null | undefined): string {
  if (!at) return '—'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * One agent stopped on something, at the top of the screen.
 *
 * Allow presses the digit that means yes and Deny presses escape — the two
 * answers the desktop's numbered list always has, and the same two the chat's
 * own permission card sends. Everything else about a prompt lives on the
 * block it came from, which only the chat has, so a question with options and
 * a session nothing can type into both offer the conversation instead of an
 * answer that would be a guess.
 */
function AskCard({
  session,
  onSend,
  onOpen,
}: {
  session: AgentSession
  onSend: (key: '1' | 'Escape') => Promise<void>
  onOpen: () => void
}) {
  const palette = usePalette()
  const [acting, setActing] = useState<'1' | 'Escape' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const ask = readAsk(session.prompt)
  const answerable = Boolean(ask && session.writable)

  const press = (key: '1' | 'Escape') => {
    setActing(key)
    setError(null)
    onSend(key)
      .catch(setError)
      .finally(() => setActing(null))
  }

  const name = session.title || basename(session.cwd) || session.agent
  return (
    <Card tone={palette.orange}>
      <CardHeader
        icon={ask ? 'alert-circle' : 'help-circle'}
        title={ask ? `${name} wants ${ask.tool}` : name}
        subtitle={`${session.agent} · waiting ${waited(session.lastActivity)}`}
        tone={palette.orange}
      />
      <Code lines={4}>{ask ? ask.what || `${ask.tool} needs your permission` : session.prompt}</Code>
      <Notice error={error} tone="warning" />
      {answerable ? (
        <Buttons>
          <Button label="Deny" onPress={() => press('Escape')} compact disabled={acting !== null} loading={acting === 'Escape'} />
          <Button label="Allow" variant="primary" onPress={() => press('1')} compact disabled={acting !== null} loading={acting === '1'} />
        </Buttons>
      ) : (
        <Buttons>
          <Button label="Open chat" icon="message-square" variant="primary" onPress={onOpen} compact />
        </Buttons>
      )}
      {/* The two reasons a card cannot answer itself, each said once. */}
      {ask && !session.writable ? <Hint icon="eye">Read only · answer this at the desktop</Hint> : null}
      {!ask ? <Hint icon="list">Pick an answer in the conversation</Hint> : null}
    </Card>
  )
}

/* ── usage ───────────────────────────────────────────────────────────── */

/**
 * The plan's headroom.
 *
 * The rows and their meters are `agentkit`'s, so this card and the chat's
 * status line are reading the same figures the same way. What is added here
 * is the one line the mock asks for under them — when the window that is
 * actually being spent against turns over — and the dimmed shape for a
 * desktop that has nothing to say: signed out, offline, or too old to know.
 */
function UsageCard({ limits }: { limits: AgentLimits | null | undefined }) {
  const palette = usePalette()
  const rows = limits?.limits ?? []
  // Every row measured hours ago is a memory of the plan, not its state, and
  // the card is dimmed for the same reason a capability the desktop lacks is.
  const stale = rows.length > 0 && rows.every((limit) => limit.stale)
  if (!rows.length) {
    return (
      <Card dim>
        <CardHeader icon="zap" title="Claude usage" subtitle="nothing measured" tone={palette.muted} />
        <Hint icon="cloud-off">
          {limits?.probeStatus ? `The desktop is ${limits.probeStatus}` : 'The desktop has not read the account yet'}
        </Hint>
      </Card>
    )
  }
  const active = rows.find((limit) => limit.active && !limit.stale) ?? rows.find((limit) => !limit.stale)
  const gap = active ? until(active.resetsAt) : null
  return (
    <Card dim={stale}>
      <CardHeader
        icon="zap"
        title="Claude usage"
        subtitle={limits?.probeStatus ? `the desktop is ${limits.probeStatus}` : 'from your Claude account'}
        tone={stale ? palette.muted : undefined}
      />
      <Limits limits={limits} />
      {gap && active ? <Hint icon="clock">{`${active.label} resets in ${gap}`}</Hint> : null}
    </Card>
  )
}

/* ── the list ────────────────────────────────────────────────────────── */

/** The last path segment, for a session the CLI has not named yet. */
function basename(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** One state, one word, one pill: what the right of a row says. */
function stateOf(state: AgentState): { label: string; variant: 'default' | 'on' | 'warn' } {
  switch (state) {
    case 'working':
      return { label: 'working', variant: 'on' }
    case 'waiting':
      return { label: 'waiting', variant: 'warn' }
    case 'starting':
      return { label: 'starting', variant: 'on' }
    case 'gone':
      return { label: 'done', variant: 'default' }
    default:
      return { label: 'idle', variant: 'default' }
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
  const state = stateOf(session.state)
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
  const ask = session.state === 'waiting' ? readAsk(session.prompt) : null

  // What it is working on, in the agent's own words, beats what it last did:
  // a row that says "Pushing background-agent state live" is one you can act
  // on, and "Bash grep -rn router src" is not. So the transcript's last line
  // is never shown here — when the agent has said nothing about itself, the
  // row says how long ago it moved instead.
  const doing =
    session.state === 'waiting'
      ? ask
        ? `${ask.tool}${ask.what ? `: ${ask.what}` : ''}`
        : session.prompt || 'Waiting for an answer'
      : session.state === 'starting'
        ? 'Starting'
        : (session.state === 'working' && session.tasks?.active) ||
          session.job?.detail ||
          basename(session.cwd) ||
          ago(session.lastActivity)

  return (
    <View
      style={{
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: alpha(palette.lighter_background, 0.85),
      }}
    >
      <ListRow
        // `cpu` for the one that thinks, `code` for everything else: on a list
        // of six the glyph is what tells a Claude session from a codex one
        // before any of the words are read.
        icon={session.agent === 'claude' ? 'cpu' : 'code'}
        fill={session.state === 'working'}
        title={session.title || basename(session.cwd) || session.agent}
        // Which road in decides whether the composer is a text field or an
        // apology, so a row that cannot be typed into says so before it is opened.
        subtitle={readOnly ? `${doing} · read only` : doing}
        right={<Pill label={state.label} variant={state.variant} />}
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
  return (
    <ListRow
      title={worker.description || worker.type || worker.id}
      subtitle={worker.preview || (worker.running ? 'Just started' : `Finished ${ago(worker.updatedAt)}`)}
      right={<Pill label={worker.running ? 'working' : 'done'} variant={worker.running ? 'on' : 'default'} />}
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
  // The state file outlives the process, so `working` on a dead job is
  // history, not status — a daemon that knows says so, and the row goes grey
  // rather than keep a pulse going for an agent that is not there.
  const live = job.live !== false
  const variant = !live
    ? 'default'
    : job.state === 'working'
      ? 'on'
      : job.state === 'waiting' || job.state === 'blocked'
        ? 'warn'
        : 'default'
  return (
    <ListRow
      icon="moon"
      title={job.name}
      subtitle={job.detail || `${tokens(job.tokens)} tokens · ${ago(job.updatedAt)}`}
      right={<Pill label={live ? job.state : 'ended'} variant={variant} />}
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
