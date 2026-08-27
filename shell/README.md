# Omarchy Connect — desktop client

The Omarchy side of the link, as a bar widget and a panel. One icon says
whether a phone is on the other end; one click opens everything the desktop
knows about it and everything you do from here.

It is an ordinary Omarchy shell plugin — `manifest.json` plus QML, loaded out
of `~/.config/omarchy/plugins/omarchy-connect.phone/` by the running
`omarchy-shell` process. No build step, no root, no second Quickshell.

```bash
omarchy-connect panel install     # copy, validate, rescan, add to the bar
omarchy-connect panel status      # where it is and whether the bar has it
omarchy-connect panel remove
```

Installing again after editing the QML copies and rescans, but a bar widget
that is already mounted keeps its compiled component — the new version only
appears after `omarchy-restart-shell`. The install command says so when it is
replacing an existing copy.

## Panel

The panel is built around one rule: the top of it answers the question you
opened it to ask, anything that has just happened gets a card of its own, and
everything else waits behind a row you can open. What follows is in the order
it is drawn.

- **Hero** — the connected phone's name and platform, one line of state, and a
  switch that starts and stops the daemon. That line is the panel's only
  unconditional readout, and it carries what a grid of a dozen cells used to
  say between them: `Encrypted · 2h 14m · 63%` while the link is up,
  `Offline · last seen 3m ago` once it drops, and the reason otherwise —
  daemon stopped, no phone paired, waiting for a phone. With no phone connected
  the hero falls back to the desktop's own name.
- **Pairing card** — only while a code is live: the six digits, a countdown,
  and a button that reopens the QR code.
- **Call card** — the one card that is a remote control rather than a readout.
  It appears while a call is live, urgent while it is ringing, with **Answer**
  and **Decline**. Any road: hands-free is preferred because it is the link
  that carries the audio, but a handset that connects over the profile and
  never publishes its calls is common, and the card falls back to the mirrored
  event for those. The dim line says which of the two is about to happen —
  whether answering brings the sound here or leaves it on the handset. It is
  also the only place to *decline* on a notification server that draws no
  action buttons, Omarchy's own among them. Answering from the panel goes
  through `omarchy-connect call answer` like everything else here.
- **Firewall card** — appears only when the daemon reports that its port is
  closed, and carries the exact `ufw` command. The panel never runs it;
  opening a port is the user's call.
- **Coding agents** — whatever is running, with an agent that has stopped to
  ask you something in the urgent colour. Only the sessions: the switch that
  decides whether the phone may see them is a preference and lives under
  *Settings*. Hidden until reading is on and something is actually running.
- **From the phone** — the last few mirrored messages, calls and app
  notifications, missed calls in the urgent colour. Three sources feed one
  list: an Android build over the LAN, the hands-free link, and an iPhone's own
  notifications over low energy. Hidden entirely until something arrives, which
  in Expo Go with no Bluetooth paired is never.
- **Recent transfers** — the last few files across the link, either direction.
- **Actions** — Pair *or* Unpair, then Send and Inbox. Three, and all three are
  things you came here to do. The first slot is the way in while the desktop is
  free and the way out once it is taken, never both: offering Pair next to a
  phone that is already paired would be a button whose only outcome is a
  refusal.
- **Details** — one collapsed row, and behind it where the daemon can be
  reached and how to recognise it: the transport, the address, the desktop's
  identity fingerprint. Address and fingerprint copy on click; `plain` sits in
  the dim colour, because it is the state of the transport rather than a fault.
  None of this changes between one week and the next, which is why none of it
  is on screen by default.

  Every other row here is gated on having something to say, because a readout
  whose whole content is *no* is not a readout. **Files** (`3 in · 1 out`) and
  **Notified** (`12 mirrored`, plus `2 missed` in the urgent colour once there
  are any) appear once the counters leave zero. **Bluetooth** appears while the
  hands-free link is carrying something or has failed at it, and stays folded
  away the rest of the time — the desktop holds that link open on its own
  behalf, and *not connected* is its resting state rather than news. **iPhone**
  is the other Bluetooth link, the low-energy one an iPhone mirrors its
  notifications over, and it appears only for a handset that is bonded: the
  name while it is mirroring, *idle* when it is bonded but declining to share.
  A desktop paired to an Android phone never draws either row, because neither
  would be telling it anything about the phone it actually has.
- **Settings** — the other collapsed row, holding the two switches that are
  decided once and then left alone for months.
  - *Let the phone read and answer agents* — the one control on this panel that
    changes what the phone is allowed to see. Turning it **on** asks first,
    naming what the phone will be able to see — source, commands, the output of
    those commands — because that is a wider door than anything else here and
    one click is not enough thought for it. Turning it off is immediate. When
    the hooks are missing a row says what that costs — the desktop can see an
    agent working but not that it is stuck — and offers to install them. The
    switch stays hidden on a machine with no coding agent installed, where it
    would only be a question. It follows the daemon's own gate: reading is off
    until someone here turns it on.
  - *Start at login* — whether the daemon comes up with the session. Starting
    and stopping it *right now* is the hero's switch, which is a separate
    decision and stays where you can reach it without opening anything.

Both sections start shut on every open. A panel that remembered being expanded
would be back to drawing everything at once within a week.

There is no **Paired phone** row any more. It said the phone's name, platform
and state — which is the hero, three centimetres above it — and carried an
unpair button that is also the first slot of the action row. Its address moved
into *Details*, and nothing else on it was ever news.

## Data

The panel is strictly a display. The daemon publishes one file:

```
~/.local/state/omarchy-connect/status.json
```

and rewrites it, atomically, the moment anything changes — a phone connects,
a file moves, a pairing code is minted. The panel watches that file, so it
reacts as fast as the daemon does without polling, and still has something
true to draw (desktop name, fingerprint, the paired phone) while the daemon is
stopped.

The one thing a file cannot report is its own writer being killed. So while
the panel is open, `omarchy-connect status --json` runs on a slow timer; it
probes loopback, has the final word on `running`, and rewrites a stale file.
That interval is the plugin's only setting.

TLS is reported, never switched: turning it on means minting a certificate and
restarting the daemon, which is `omarchy-connect tls enable` and not something a
bar widget should do behind a click. Agent reading is the counter-example, and
the difference is exactly that: the daemon applies it live — it writes the
config and starts or stops watching in the same call — so the switch costs
nothing but the click, and the phone does not lose its link over it. It is also
a decision that belongs on the desktop rather than in the app, which is the
other half of why it is here. Both Bluetooth rows are reported the same
way — pairing a handset belongs in Bluetooth settings, and opening a window in
which this machine advertises itself to the neighbourhood (`omarchy-connect ios
pair`) is even less of a thing to hide behind a click.

Every action shells out to the same CLI a person would use. The argv is read
from the `exec` field of the status file rather than from `$PATH`, so a daemon
running out of a checkout works without being installed anywhere.

What that CLI writes for a terminal is not what a panel can draw, so its output
is cleaned before it is shown: colour escapes and the timestamped tag in front
of every line are stripped, and one sentence is left. A command that fails puts
that sentence in the urgent colour; a command that *succeeds* and still warns —
a daemon too old to take a switch live is the case this exists for — shows it
dimly, because a panel that looks like nothing happened is worse than a line
that says what did.

## Keyboard

`j`/`k` move down and up the panel, `h`/`l` walk the action row, Enter
activates, `x` unpairs the phone, `p` pairs, `s` sends, `i` opens the inbox,
`r` refreshes, Tab moves to the neighbouring bar panel, Esc closes. `p` with a
phone already paired says which one is in the way rather than acting: dropping
a pairing is not something one unmodified keystroke should be able to do.

`e` opens and shuts **Details**, `c` does the same for **Settings** — the two
folded sections are one keystroke away for a keyboard user rather than
permanently on screen for everybody. `j` walks into whichever of them is open
and past whichever is not, which is the same rule the eye follows.

`a` answers a ringing call and `d` declines it — or hangs up one already in
progress. Both do nothing when there is no call, so a mistyped key on an idle
panel is harmless.

The agent switch has no letter of its own, deliberately: every letter on this
panel is one keystroke away from something, and widening what leaves this
machine is not a thing to hand to a mistyped key. It is reached by opening
Settings and walking to it. While its question is on screen it owns the
keyboard — `h`/`l` move between the answers, Enter takes the highlighted one,
Esc says no — and the panel behind it stays put.

## IPC

```bash
omarchy-shell omarchy-connect toggle
omarchy-shell omarchy-connect pair
omarchy-shell omarchy-connect refresh
omarchy-shell omarchy-connect status
```

## Settings

Settings live inline on the widget's entry in `~/.config/omarchy/shell.json`.

| Key | Default | What it does |
|---|---|---|
| `refreshIntervalSec` | `15` | How often an open panel re-confirms the daemon is alive |
| `hideWhenUnpaired` | `false` | Leave the bar alone until a phone has been paired |

```bash
omarchy bar set omarchy-connect.phone refreshIntervalSec 30 --json
omarchy bar set omarchy-connect.phone hideWhenUnpaired true --json
```
