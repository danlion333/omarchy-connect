# Remote agent control — design

Driving a coding agent that is already open on the desktop from the phone: read
its chat, answer it, unblock it. This document is the plan. **Stages one and
two — reading and writing — are implemented**; see the staged plan at the
bottom for what that covers and what it does not.

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
| `PreToolUse` (`AskUserQuestion`) | `state = waiting`, carrying the question and its options |
| `PostToolUse` (`AskUserQuestion`) | the question has been answered — take it off the screen |

The tool pair is narrowed with a matcher, and the narrowing is not tidiness: an
unmatched `PreToolUse` spawns a process on every `Bash` an agent runs, a tax on
the agent for the sake of one tool in a hundred. Scoped to `AskUserQuestion` it
fires only when there is something for a phone to do.

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
{ "t": "req", "id": 13, "method": "agents.send",  "params": { "id": "claude:2fe…", "text": "так, продовжуй" } }  // shipped
{ "t": "req", "id": 14, "method": "agents.key",   "params": { "id": "claude:2fe…", "key": "Escape" } }      // shipped
{ "t": "req", "id": 15, "method": "agents.screen","params": { "id": "claude:2fe…" } }                       // shipped
{ "t": "req", "id": 16, "method": "agents.answer","params": { "id": "claude:2fe…", "seq": 16, "choices": [2] } }  // shipped
{ "t": "req", "id": 17, "method": "agents.attach","params": { "id": "claude:2fe…", "paths": ["…/shot.png"], "text": "?" } }  // shipped
{ "t": "req", "id": 18, "method": "agents.spawn", "params": { "agent": "claude", "cwd": "…", "prompt": "…" } }

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
- `capabilities.agents` = `{ enabled, adapters: ["claude"], read, write: "tmux" | "wtype" | null, keys, spawn }`,
  so the app greys out what this machine cannot do rather than failing at call
  time — the convention the rest of the protocol already follows.

## App

A new `Agents` tab (`app/src/screens/AgentsScreen.tsx` + `AgentChatScreen.tsx`):

- **List** — one row per session: agent glyph, project name, state dot,
  last line. `waiting` sorts to the top and pulses.
- **Chat** — user/assistant bubbles, tool calls as one-line chips that expand
  on tap, a "thinking" chip that stays collapsed.
- **Input** — a text field, plus a quick row that is the real ergonomic win:
  `Yes` / `No` / `Esc` / `1` `2` `3` for numbered prompts, and a paperclip for
  a screenshot.
- **Raw** — the `capture-pane` view behind a toggle.

The tab-bar badge in `App.tsx` carries one count and one meaning: "an agent is
waiting for you".

The Omarchy shell panel (`shell/Panel.qml`, fed by `status.json`) shows the
same thing on the desktop — running sessions and which of them is waiting, on
the panel proper — and carries the switch itself, along with the hooks button,
under **Settings**. See *The switch on the desktop* below.

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

### The switch on the desktop

The decision is the desktop's, and the desktop client is where a decision like
this belongs — so the panel carries it under **Settings**, with the other switch
that is set once and left alone, and it is the one control there that asks
before it acts. What the agents are *doing* stays on the panel proper, under
**CODING AGENTS**: that changes by the minute, the switch does not.

Three properties keep that from widening the surface:

- **Loopback only.** The panel's switch runs `omarchy-connect agent enable`,
  which reaches the daemon on `POST /api/agent/control` — the same
  localhost-only door the lifecycle hook uses. There is no method a phone can
  call to grant itself reading; `agents.enable` does not exist, and the test
  suite asserts that a paired phone asking for it gets *unknown method*.
- **The daemon owns both halves.** It writes `agents.enabled` to the config, so
  the decision survives a restart, *and* starts or stops the watching in the
  same call. Nothing needs restarting, which matters more than it sounds: a
  switch that costs you the phone's link is a switch nobody flips, and a
  feature only reachable by restarting the daemon would have stayed a CLI
  feature in practice.
- **Off is immediate and total.** Turning it off closes every transcript held
  open, forgets every session, and refuses the next `agents.list` — a held file
  descriptor is a read.

Turning it *on* goes through a confirmation naming what the phone will see;
turning it off does not, because closing a door needs no second thought. The
same event that flips the switch (`agent` / `kind: "control"`) is pushed to the
connected phone, so the app's Agents screen fills without reconnecting — the
capabilities it learned from `hello` are patched in place.

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
- The Omarchy bar panel now carries the whole thing: the counts from
  `status.json` (`agents.running`, `agents.waiting`), the session list, an
  *Install* button for the hooks, and the switch itself — which is why
  `agents.enabled` became a live change rather than a restart. The session list
  is on the panel; the switch and the hooks button fold away under *Settings*.

**Stage 2 — write. Done.** `daemon/src/agents/tmux.js`,
`daemon/src/agents/writer.js`, `daemon/src/agents/proc.js`, `agents.send` /
`agents.key` / `agents.screen`, the `agent run` wrapper, the composer and the
raw-screen toggle in the app, the panel's consent text. Verified against a real
pty rather than a mock, because the point of the tmux road is that the bytes
arrive at the far end of somebody else's terminal and only a real one can say
whether they did. Four things came out differently from this sketch:

- *Writing is not its own switch.* It arrives with `agents.enabled`, as
  designed above, which means turning reading on now grants a shell — so
  everything that asks for that consent says so: the panel's confirmation, what
  `agent enable` prints, and the app's own explanation of what is off.
- *`agents.screen` moved up from stage three.* It belongs with writing rather
  than with breadth: a permission prompt is drawn on the terminal and never
  written to disk, so the numbered options a phone is about to answer exist
  nowhere else. It is captured plain — `-e` keeps the SGR sequences, and a
  phone rendering escape codes as text is worse than one without colour.
- *tmux discovery turned out to be adoption only.* The scan already finds every
  `claude` in `/proc` whether or not it is in a pane, so what tmux adds is not
  another road to discovery but the answer to "can this one be typed into" —
  which is a walk *up* the process tree from the agent to the pane, not a walk
  down from the pane looking for an agent.
- *The keys are a whitelist.* `send-keys` would forward anything; the set worth
  giving a phone is eleven names and nine digits, and `capabilities.agents.keys`
  publishes it so the app builds its quick row from what the desktop accepts.

**Stage 2½ — the two things a phone could see but not do. Done.**
`agents.answer` and `agents.attach`, the `question` block in the Claude adapter,
the drop directory and the second door on `/api/upload`, and the question card
and paperclip in the app. Both came out of the same observation: the screen
could already show what the agent was blocked on, and in both cases the person
holding the phone still had to get up.

- *A multiple-choice question is a tool call, so it is on disk — but not while
  it is being asked.* Every other tool call is collapsed to one line on its way
  to the phone; this one arrives whole, because the options are the entire
  reason it is worth carrying. What took a second pass, on a real phone
  watching a real agent, is that Claude Code holds the whole assistant turn
  back until the tool inside it has returned: a question the agent is *blocked
  on* is in no file, and by the time `AskUserQuestion` reaches the transcript
  it has already been answered at the keyboard. So the card the phone draws
  comes from a `PreToolUse` hook, and the transcript copy that lands later is
  dropped as the duplicate it is, matched on `tool_use_id`. This also unmakes
  half of an answer claimed below: a session found by scanning `/proc`, with no
  hooks at all, cannot see a question either.
- *The words the question was held back with cannot be carried at all.* The
  withheld turn is usually the agent explaining what it is about to ask about —
  the paragraph a person on the sofa would actually decide on — and no hook has
  it: `PreToolUse` is handed `tool_input`, which is the question and nothing
  else. So the phone draws the card and, until the answer releases the turn,
  nothing above it. What *is* fixable is where those words land when the file
  finally catches up: they were written before the question, so the card that
  has been on screen for minutes slides down to stand behind them rather than
  leaving an explanation printed after the question it explains. The card keeps
  its `seq` through the move — the phone answers a question by `seq`, and a card
  that renumbers under a thumb answers the wrong one — and the list is re-sent
  whole, because a block that moved is not something an appending reader can be
  told about one block at a time. The live half is only reachable off the
  terminal itself: `agents.screen`, which is tmux-only.
- *An option's position is the keystroke that picks it*, so the app draws the
  numbers where the terminal draws them and `agents.answer` takes a block and an
  index rather than a digit. The desktop then checks the option against the
  question it actually asked, and a stale screen gets a refusal rather than
  answering the next prompt by accident.
- *A multi-select does not submit on Return.* The digits only tick boxes, and
  the Return that submits a single-choice list toggles whatever row is
  highlighted here — a phone quietly adding an option nobody picked, which is
  what the pane showed the first time this was driven from the sofa. The prompt
  carries tabs above the list, so the answer walks off the checkbox screen with
  `Right` and presses Return on the submit tab, with a wider gap between keys
  because a screen that has just been drawn ignores the key arriving on its
  heels.
- *A picture crosses as a file and arrives as a path.* Not a workaround for a
  terminal that cannot carry an image — it is how an image is passed, because
  an agent reads one by opening it. It goes to a swept cache directory rather
  than the share inbox: a screenshot handed to an agent is scaffolding for one
  question, not a file anybody meant to keep.
- *The clipboard is the source that matters.* A screenshot that was just
  cropped or marked up is in the clipboard and nowhere a picker can reach it,
  and that is the common case — so it sits beside Photos and Files rather than
  under them.

**Stage 3 — breadth.** Codex adapter, Gemini adapter, `capture-pane` raw mode
for everything else.

**Stage 4 — spawn.** Headless sessions started from the phone.

## Open questions

- Codex's rollout schema needs to be read from a live file before its adapter
  is written.
- Whether `waiting` can be detected without hooks. Answered, and the answer is
  no. Both kinds of block are invisible on disk while they matter: a permission
  prompt is drawn on the terminal and written down nowhere, and a question is
  written down only once it has stopped being one, because the assistant turn
  is flushed with the tool result inside it. A scan-discovered session can say
  an agent is quiet; only a hook can say what it is waiting on. The inverse
  still holds — a prompt answered at the keyboard fires no hook we subscribe
  to, so a permission `waiting` is cleared by the transcript moving again
  rather than by an event, while a question's is cleared by `PostToolUse`. A
  `capture-pane` heuristic would cover the permission half, but only inside
  tmux.
- Whether a multi-select prompt really toggles on the digit. Answered on the
  device: it does, and the Return that was supposed to submit toggled the
  highlighted row instead. The chord is digits, `Right`, Return. The TUI that
  draws it is still not this project's, so the app keeps the raw-screen toggle
  within reach and one `Escape` undoes a wrong guess.
- Whether one phone writing while the person at the keyboard also writes needs
  more than a warning. Half-answered: writes are serialised per session inside
  the daemon, so two sends cannot interleave halfway through a paste. Nothing
  serialises the phone against the keyboard, and on the `wtype` road nothing
  can — the compositor has one keyboard and both are using it. Still open
  whether the tmux road should take a soft lock while a send is in flight.
