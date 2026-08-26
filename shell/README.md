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

- **Hero** — the connected phone's name and platform, the state of the link,
  and a switch that starts and stops the daemon. With no phone connected the
  hero falls back to the desktop's own name.
- **Pairing card** — only while a code is live: the six digits, a countdown,
  and a button that reopens the QR code.
- **The numbers** — link state, notifications mirrored, the phone's battery,
  how long the link has been up (or when the phone was last seen), files in and
  out, whether the transport is TLS or plain, missed calls, whether a handset is
  on Bluetooth, the daemon's address, and the desktop's identity fingerprint.
  Address and fingerprint copy on click. Missed calls turn urgent when there are
  any; `plain` sits in the dim colour, because it is the state of the transport
  rather than a fault. Bluetooth reads *unsupported* when this machine's
  PipeWire is older than 1.4 and *not connected* when nothing is paired — a
  distinction worth making, because only one of them is fixable by pairing.
  The **iPhone** row beside it is the other Bluetooth link — the low-energy one
  an iPhone mirrors its notifications over — and it reads *not paired*,
  *idle* (bonded, but the phone declined to share notifications) or the
  handset's name while it is mirroring.
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
- **Paired phone** — one row, filled while the link is live, with an unpair
  action. A desktop pairs one phone at a time, and the row says so.
- **Coding agents** — the one card that changes what the phone is allowed to
  see. A switch decides whether a paired phone may read the coding agent open
  on this desktop; under it, whatever is running, with an agent that has
  stopped to ask you something in the urgent colour, and the line that says
  reading is all this does so far. Turning it *on* asks first, naming what the
  phone will be able to see — source, commands, the output of those commands —
  because that is a wider door than anything else on this panel and one click
  is not enough thought for it. Turning it off is immediate. When the hooks are
  missing a row says what that costs — the desktop can see an agent working but
  not that it is stuck — and offers to install them. The whole card stays
  hidden on a machine with no coding agent installed, where the switch would
  only be a question. It follows the daemon's own gate: reading is off until
  someone here turns it on.
- **From the phone** — the last few mirrored messages, calls and app
  notifications, missed calls in the urgent colour. Three sources feed one
  list: an Android build over the LAN, the hands-free link, and an iPhone's own
  notifications over low energy. Hidden entirely until something arrives, which
  in Expo Go with no Bluetooth paired is never.
- **Recent transfers** — the last few files across the link, either direction.
- **Actions** — Pair *or* Unpair, then Send, Inbox, and Autostart. The first
  slot is the way in while the desktop is free and the way out once it is
  taken, never both: offering Pair next to a phone that is already paired
  would be a button whose only outcome is a refusal. Autostart is a checkbox, not
  a button: it shows whether the daemon runs at login and flips it. Starting
  and stopping the daemon *right now* is the hero's switch, which is a separate
  decision.

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

`j`/`k` move, `h`/`l` walk the action row, Enter activates, `x` unpairs the
selected phone, `p` pairs, `s` sends, `i` opens the inbox, `r` refreshes, Tab
moves to the neighbouring bar panel, Esc closes. On the phone row Enter does
what `x` does — unpairing is the only thing that row is for. `p` with a phone
already paired says which one is in the way rather than acting: dropping a
pairing is not something one unmodified keystroke should be able to do.

`a` answers a ringing call and `d` declines it — or hangs up one already in
progress. Both do nothing when there is no call, so a mistyped key on an idle
panel is harmless.

The agent switch has no key of its own, deliberately: every letter on this panel
is one keystroke away from something, and widening what leaves this machine is
not a thing to hand to a mistyped key. While its question is on screen it owns
the keyboard — `h`/`l` move between the answers, Enter takes the highlighted
one, Esc says no — and the panel behind it stays put.

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
