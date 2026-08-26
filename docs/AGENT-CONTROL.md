# Remote agent control — design

Driving a coding agent that is already open on the desktop from the phone: read
its chat, answer it, unblock it. This document is the plan. **Stage one — the
reading half — is implemented**; see the staged plan at the bottom for what
that covers and what it does not.

```
phone ──ws── daemon ──┬── adapter  ──► ~/.claude/projects/…/<session>.jsonl   read
                      ├── hook     ◄── claude hooks over 127.0.0.1            register + notify
                      └── writer   ──► tmux send-keys  |  wtype + focus       write
```

## The shape of the problem

Reading a chat and writing into it are two independent problems with different
answers, and conflating them is what makes this look harder than it is.

**Reading is easy and already solved by the agents themselves.** Every CLI
agent keeps a structured transcript on disk. Nothing has to be scraped off a
terminal and nothing has to be injected to get it.

**Writing is the hard half.** The agent owns a TTY that belongs to somebody
else's process, and there is no supported way to push bytes into a foreign
terminal: `TIOCSTI` is gone (this machine's kernel does not even expose
`dev.tty.legacy_tiocsti_restrict` — the ioctl is compiled out, not merely
restricted). Whatever writes has to be either a multiplexer that owns the pty
or the compositor typing on the user's behalf.

## Do different agents need different implementations?

Only in a thin layer. The split:

| Layer | Per-agent? | Why |
| --- | --- | --- |
| Transport, protocol, encryption | no | already exists |
| Session registry, state machine | no | same lifecycle everywhere |
| Writing (tmux / wtype) | no | it is a terminal either way |
| App UI | no | a chat is a chat |
| **Transcript location + parsing** | **yes** | every agent invented its own format |
| **Real-time signals (hooks)** | **yes** | only some agents have them |

So one `agents` plugin, plus an adapter per agent of roughly 150–200 lines.

## Session model

A session is what the phone lists and opens:

```jsonc
{
  "id": "claude:2fe60a4a-…",       // adapter id + native session id
  "agent": "claude",
  "title": "omarchy-connect",       // basename of cwd
  "cwd": "/home/dan/Projects/omarchy-connect",
  "state": "idle" | "working" | "waiting" | "gone",
  "writable": "tmux" | "wtype" | null,
  "pane": "%3",                     // tmux pane, when there is one
  "pid": 53316,
  "startedAt": 1756100000000,
  "lastActivity": 1756100420000,
  "preview": "…last assistant line…"
}
```

`state` is the field the whole feature hangs on. `waiting` — the agent asked a
question or hit a permission prompt — is the one that earns a push
notification, because that is the moment a person on the sofa can actually help.

## Discovery: three roads, in order of precedence

### 1. Hooks (authoritative, Claude Code)

Claude Code runs shell hooks and feeds them JSON on stdin containing
`session_id`, `transcript_path`, `cwd` and `hook_event_name`. The hook process
inherits the agent's environment, so it also knows `$TMUX_PANE` and `$PPID`.
That single fact solves the correlation problem — which transcript belongs to
which pane — that no amount of process scanning solves cleanly.

`omarchy-connect agent hook` reads stdin, adds the environment, and POSTs to
`127.0.0.1:<port>/api/agent/hook` (loopback-only, like the other CLI
endpoints). Installed into `~/.claude/settings.json` by
`omarchy-connect agent install-hooks`:

| Hook | Effect |
| --- | --- |
| `SessionStart` | register the session, record pane/pid/transcript |
| `UserPromptSubmit` | `state = working` |
| `Stop` | `state = idle`, emit `agent` event, push if the phone asked |
| `Notification` | `state = waiting` — this is the permission prompt |
| `SessionEnd` | `state = gone` |

Hooks must never block the agent: fire-and-forget POST with a 1s timeout, and a
daemon that is not running is a silent no-op rather than an error.

### 2. tmux scan (works for any agent)

```
tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_path} #{pane_current_command}'
```

`pane_current_command` reports the foreground process of the pane's shell and
is unreliable for wrappers — a verified pane running `cat` reported `bash` — so
the pane's process subtree is walked (`/proc/<pid>/task/*/children`, or `ps
--ppid`) looking for a known agent binary. Panes discovered this way are
writable; their transcript is matched by `cwd` + newest-file, which is a
heuristic and is marked as one.

### 3. Process scan (read-only fallback)

`ps` for known agent binaries, then `/proc/<pid>/cwd`. This is how a session
like the one this document was written in — `claude` in a bare `foot` window,
no tmux — becomes visible. It is readable and, with the compositor writer
below, writable too, but it can never be as certain as a hook.

## Reading

### Adapters

```js
// daemon/src/agents/claude.js
export default {
  id: 'claude',
  binaries: ['claude'],
  detect(),                          // is this agent installed?
  sessionsFor({ cwd, pid, hint }),   // locate transcript files
  parse(line),                       // one JSONL line → zero or more blocks
  watch(session, onBlock),           // incremental tail, fs.watch + byte offset
}
```

A parsed block is agent-neutral:

```jsonc
{ "role": "user" | "assistant", "kind": "text", "text": "…" }
{ "role": "assistant", "kind": "tool", "tool": "Bash", "summary": "ls -la", "status": "ok" }
{ "role": "system", "kind": "state", "state": "waiting", "prompt": "Allow Bash?" }
```

Collapsing tool traffic into one line per call is deliberate: a phone screen
cannot carry a 400-line `tool_result`, and the interesting part of a tool call
is that it happened and whether it worked. The full body stays one tap away.

**Claude Code.** `~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl`, one JSON
object per line. Relevant types: `user` (string content, or an array carrying
`text` / `tool_result` parts), `assistant` (array of `text` / `thinking` /
`tool_use`). Filtering rules, all verified against a real transcript:

- `isSidechain: true` marks subagent traffic — group it under its parent tool
  call rather than interleaving it into the main chat.
- `thinking` blocks frequently carry an empty `thinking` string and only a
  `signature` (encrypted). Never render the signature; show a collapsed
  "thinking" marker or drop it.
- Bookkeeping types (`mode`, `permission-mode`, `file-history-snapshot`,
  `bridge-session`, `atis-latch`) are skipped.

A 62-line transcript reduced to 25 chat blocks in a prototype — the right order
of magnitude for a phone.

**Codex.** `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`, same tail-and-parse
shape, different keys. (Not present on this machine — codex has not been run —
so the exact schema needs confirming against a live file before coding.)

**Gemini CLI / Aider.** Later, and cheap once the interface above exists.

### Universal fallback: the screen

For an agent with no adapter, `tmux capture-pane -p -e -t <pane>` returns the
visible screen with SGR sequences intact. The app renders it as a monospace
block, not as a chat. This is the honest fallback: it says "this is a terminal"
rather than pretending to understand a conversation it cannot parse. Worth
having as an explicit "raw" toggle on adapter-backed sessions too, for the
moments when the TUI shows something the transcript does not.

## Writing

### Primary: tmux

Verified end to end on this machine:

```bash
tmux send-keys -t %3 -l -- 'привіт агенте'   # -l = literal; UTF-8 survives
tmux send-keys -t %3 Enter
printf 'line one\nline two' | tmux load-buffer -
tmux paste-buffer -t %3 -p -d                # -p = bracketed paste
```

Single-line text goes through `send-keys -l`; anything with a newline goes
through `load-buffer` + `paste-buffer -p`, because a TUI that has enabled
bracketed paste needs the multi-line input to arrive as a paste rather than as
a burst of Return presses that submit half a message. tmux emits the brackets
only when the application asked for them, so the same call is correct for both.

`agents.key` sends named keys — `Escape` to interrupt, `Enter`, digits for a
numbered permission prompt, `C-c`. This is what makes answering a prompt from
the phone possible without a keyboard.

To get sessions into tmux in the first place:

- `omarchy-connect agent run -- claude` — starts the agent in a dedicated
  session (`oc-agent-<n>`), attached in the current terminal, so the desktop
  experience is unchanged and the phone gets a writable pane for free.
- Already-running tmux panes are adopted by the scan above.

### Fallback: the compositor types

For an agent in a bare terminal, the daemon already owns both halves: `wtype`
(`input.text`) and Hyprland focus (`hypr.focus`). The window that owns the
agent is found by walking up from the agent pid to the pid Hyprland reports for
each client — verified as workable on this machine (`claude` pid 53316 in
`pts/0`, inside `foot` pid 2988). Then: remember focus → focus the terminal →
type → `Return` → restore focus.

This is genuinely worse and the app must say so: it steals focus for a moment,
it corrupts the message if the user is typing at the same time, and it cannot
be made atomic. It ships because "the agent I already have open" is the whole
point of the feature, and requiring tmux would exclude the common case. The app
labels such a session `writable: "wtype"` and warns on the first send.

### Not a fallback: headless spawn

`claude -p --input-format stream-json --output-format stream-json` (and
`codex exec`) give a perfectly structured, perfectly controllable session with
no terminal involved. It is worth having — "start a task from the phone" is a
good feature — but it answers a different question than this document does. It
creates a session; it does not join one.

## Protocol surface

An extension of protocol v2, gated by capability so old apps and old daemons
keep working.

```jsonc
{ "t": "req", "id": 9,  "method": "agents.list" }                                          // shipped
{ "t": "req", "id": 10, "method": "agents.open",  "params": { "id": "claude:2fe…", "limit": 60 } }  // shipped
{ "t": "req", "id": 11, "method": "agents.close", "params": { "id": "claude:2fe…" } }      // shipped
{ "t": "req", "id": 12, "method": "agents.detail","params": { "id": "claude:2fe…", "seq": 14 } }    // shipped
{ "t": "req", "id": 13, "method": "agents.send",  "params": { "id": "claude:2fe…", "text": "так, продовжуй" } }
{ "t": "req", "id": 14, "method": "agents.key",   "params": { "id": "claude:2fe…", "key": "Escape" } }
{ "t": "req", "id": 15, "method": "agents.screen","params": { "id": "claude:2fe…" } }
{ "t": "req", "id": 16, "method": "agents.spawn", "params": { "agent": "claude", "cwd": "…", "prompt": "…" } }

{ "t": "ev", "event": "agent", "data": { "id": "…", "kind": "blocks" | "state" | "session", … } }
```

Two things the shipped surface added to this sketch. `agents.close` exists
because the daemon has to know when to stop tailing a transcript, and a phone
that disconnects cannot be relied on to say so — the subscription count is the
backstop, `close` is the polite path. And the block event is `blocks`, plural:
one drain of a transcript routinely yields a text block, four tool calls and
their results, and sending six frames where one will do is six times the
crypto for the same screen.

`agents.open` returns a snapshot plus a cursor; later blocks arrive as `agent`
events, so the phone never polls. Only sessions the phone has opened stream
their blocks — the same reference-counted discipline the stats sampler already
uses — while `state` changes stream for every session, because that is what
drives the badge and the push.

Two integration points that are easy to miss:

- `DEFAULT_EVENTS` in `daemon/src/server.js` filters `sub` frames; `agent` has
  to be added there or subscriptions are silently dropped.
- `capabilities.agents` = `{ enabled, adapters: ["claude"], write: "tmux" | "wtype" | null, spawn }`,
  so the app greys out what this machine cannot do rather than failing at call
  time — the convention the rest of the protocol already follows.

## App

A new `Agents` tab (`app/src/screens/AgentsScreen.tsx` + `AgentChatScreen.tsx`):

- **List** — one row per session: agent glyph, project name, state dot,
  last line. `waiting` sorts to the top and pulses.
- **Chat** — user/assistant bubbles, tool calls as one-line chips that expand
  on tap, a "thinking" chip that stays collapsed.
- **Input** — a text field, plus a quick row that is the real ergonomic win:
  `Yes` / `No` / `Esc` / `1` `2` `3` for numbered prompts.
- **Raw** — the `capture-pane` view behind a toggle.

The `unreadCount` badge machinery in `App.tsx` already exists for alerts and
generalises to "an agent is waiting for you".

The Omarchy shell panel (`shell/Panel.qml`, fed by `status.json`) should show
the same thing on the desktop: how many agents are running, how many are
blocked.

## Security

This is the most dangerous surface in the project, more so than input
injection, and it deserves to be stated plainly in `PROTOCOL.md`:

- **Writing to an agent is arbitrary code execution.** The agent will run what
  it is told to run. A phone that can type into a Claude Code session has, in
  effect, a shell.
- **Reading an agent is reading everything it saw** — source, tool output,
  whatever secrets crossed a `Bash` result. The channel is already encrypted
  end to end, but the exposure is much wider than the clipboard.

Therefore: `agents.enabled` defaults to **false** in the config and is turned on
by `omarchy-connect agent enable`, which says what it grants. Optionally
per-device rather than global, reusing the `devices[]` array. `agents.spawn`
gets its own flag — joining a session someone opened is a smaller step than
starting one from a phone.

## Staged plan

**Stage 1 — read. Done.** `daemon/src/plugins/agents.js`,
`daemon/src/agents/claude.js`, the hook CLI and installer (`omarchy-connect
agent`), `agents.list` / `agents.open` / `agents.close` / `agents.detail`, the
`agent` event, the two app screens, the tab badge on `waiting`. Discovery via
hooks + process scan, both verified against a real session on this machine.
`daemon/test/agents.mjs` covers the gate, the hooks, the state machine and the
tail. Two things came out smaller than this sketch implied:

- *Push* on `waiting` is an in-app badge, not an OS notification. Half of what
  that needed now exists: the foreground service in `app/modules/omarchy-link`
  keeps the socket and the app's timers alive with the app closed, so the
  `agent` event does arrive on a pocketed phone. What is still missing is the
  local notification to raise when it does — a piece of app work, no longer a
  piece of infrastructure.
- The Omarchy bar panel does not show agent counts yet. The data is already in
  `status.json` (`agents.running`, `agents.waiting`), so this is a QML change
  with nothing behind it left to design.

**Stage 2 — write.** tmux discovery and adoption, `agent run` wrapper,
`agents.send` / `agents.key`, the wtype fallback and its warning.

**Stage 3 — breadth.** Codex adapter, Gemini adapter, `capture-pane` raw mode
for everything else.

**Stage 4 — spawn.** Headless sessions started from the phone.

## Open questions

- Codex's rollout schema needs to be read from a live file before its adapter
  is written.
- Whether `waiting` can be detected without hooks. Still open, and now
  confirmed from the other end: nothing appears in the transcript when a
  permission prompt goes up, so a scan-discovered session can only ever be
  `idle` or `working`. Its inverse turned out to matter as much — a prompt
  answered at the keyboard fires no hook we subscribe to either, so `waiting`
  is cleared by the transcript moving again rather than by an event. A
  `capture-pane` heuristic would answer both, but only inside tmux.
- Whether one phone writing while the person at the keyboard also writes needs
  more than a warning — a soft lock in the daemon may be worth it.
