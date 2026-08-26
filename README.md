# Omarchy Connect

Your phone, wired into your Omarchy desktop. Live system stats, remote control,
a touchpad, clipboard sync, notification mirroring and file transfer — all over
your own LAN, with no account, no cloud, and no traffic leaving the subnet.

The control channel is encrypted end to end, and the phone pins the desktop's
identity key when it pairs, so it will only ever talk to the machine you
actually paired with.

The phone wears whatever Omarchy theme the desktop is wearing: switch themes on
the desktop and the app repaints in the same palette.

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│ omarchy-connect (daemon)     │        │ Omarchy Connect (Expo app) │
│  wl-paste · notify · wpctl   │◄──ws──►│  stats · remote · share    │
│  hyprctl · omarchy-*         │        │  iOS · Android             │
└──────────────────────────────┘        └────────────────────────────┘
```

## What it does today

| | |
| --- | --- |
| **Live stats** | CPU, temperature, memory, swap, disk, battery, and a network card with ping, packet loss, throughput, totals, IP, gateway and DNS provider — sampled once a second. |
| **Remote control** | Volume and mute, brightness, media keys, Hyprland workspaces and windows (focus, close), lock, sleep, reboot, shut down, screenshot, "where is my desktop". |
| **Touchpad** | Drag to move the pointer, tap to click, two fingers for right-click and scroll, plus a key row and a field that types into the focused window. No `uinput` permissions needed. |
| **Clipboard sync** | Whatever you copy on the desktop appears on the phone, and back. |
| **Notifications** | The Omarchy notification history mirrors to the phone; the phone can raise desktop notifications. |
| **Files** | Send a file or photo from the phone to `~/Downloads/Omarchy Connect/`; push a desktop file to the phone with `omarchy-connect send <file>`. |
| **Themes** | Read and switch the active Omarchy theme from the phone. |
| **DNS** | Read and switch the system DNS provider (needs a sudo rule, see below). |
| **Encryption** | X25519 key exchange, ChaCha20-Poly1305 frames, identity key pinned from the pairing QR. |
| **TLS** | Optional https + wss with a self-signed certificate the phone pins from the QR — this is what covers the file transfers too. |
| **Messages and calls** | Incoming SMS and call state from an Android phone become desktop notifications; reply with `omarchy-connect sms`. |
| **Answering calls** | Pick up or decline from the desktop — over Bluetooth the conversation comes out of your speakers, and that half needs no app at all. The desktop holds that link open by itself while the phone is on the network, so a call is answerable the moment it rings. |
| **iPhone bridge** | An iPhone mirrors its messages, calls and app notifications to the desktop over Bluetooth Low Energy, with nothing installed on the phone. |
| **Coding agents** | Read the Claude Code session already open on the desktop from your phone, and get told the moment it stops to ask you something. Off by default, and switched on from the desktop — the panel or the CLI. |
| **Follows the desktop** | If the router hands the desktop a new address, the phone finds it again by its pinned key instead of asking you to re-pair. |
| **Desktop client** | An Omarchy bar widget and panel: whether the phone is linked, its battery, recent transfers, the coding agents it may read, and one click each to pair, send a file, or open the inbox. |

## Install the daemon

```bash
cd daemon
npm install
node bin/omarchy-connect.js start
```

The first start prints a QR code, a six-digit pairing code and the desktop's key
fingerprint. Scan it in the app, and that is the whole setup — the QR carries
the identity key, so the pairing is verified rather than trusted blindly.

A desktop pairs **one phone at a time**. While a phone holds a token the daemon
mints no new codes at all: `omarchy-connect pair` says which phone is in the
way, and `omarchy-connect unpair` frees the desktop for a different one. That is
deliberate — a second live code is a second way in, and swapping phones should
be something you did on purpose rather than something whoever scanned a QR did
to you.

Typing the address by hand instead? The app shows the fingerprint it read from
the desktop; check it against the one in the terminal before you continue.

Put it on your PATH and run it as a user service:

```bash
ln -s "$PWD/bin/omarchy-connect.js" ~/.local/bin/omarchy-connect
omarchy-connect install-service
systemctl --user daemon-reload
systemctl --user enable --now omarchy-connect
```

### CLI

```
omarchy-connect start [--port N] [--pair]   run the daemon
omarchy-connect pair [--wait]               show a pairing QR code
omarchy-connect devices                     show the paired phone
omarchy-connect unpair [name|id]            forget the paired phone
omarchy-connect send <file> | --pick        offer a file to connected phones
omarchy-connect status [--json]             show live daemon status
omarchy-connect sms <number> <message…>     send an SMS through the paired phone
omarchy-connect call <status|answer|reject|…>  answer or place a call
omarchy-connect call auto <presence|ring|off>  when to hold the Bluetooth link open
omarchy-connect ios <status|pair|stop>      mirror an iPhone over Bluetooth LE
omarchy-connect phone [--limit N]           mirrored messages and calls
omarchy-connect agent <status|enable|run|…>   read and answer this desktop's coding agents
omarchy-connect tls <status|enable|…>       serve https + wss with a pinned certificate
omarchy-connect config [key] [value]        read or change configuration
omarchy-connect firewall                    check the port is reachable
omarchy-connect panel <status|install|remove>  the Omarchy bar client
omarchy-connect install-service             write a systemd user unit
```

`pair --wait` holds the QR code on screen until a phone uses it or the code
expires; `send --pick` browses for a file instead of taking a path. Both exist
because the desktop client drives them from a floating terminal.

Configuration lives in `~/.config/omarchy-connect/config.json` (mode 0600 —
it holds the device tokens).

## The desktop client

Omarchy 4 runs its desktop as one long-lived Quickshell process and loads
plugins out of `~/.config/omarchy/plugins/`. The desktop half of Omarchy
Connect is exactly that — a bar widget and a panel, in the same visual language
as the built-in network and audio panels.

```bash
omarchy-connect panel install
```

That copies `shell/` into place, validates the manifest the way the shell
would, rescans, and drops the widget on the right of the bar. Click the phone
icon (or `omarchy-shell omarchy-connect toggle`) for the panel: link state, the
phone's battery, how long it has been connected, files in and out, the address
and identity fingerprint, the paired phone with an unpair button, recent
transfers, and buttons for send / inbox. The first button is Pair or Unpair
depending on whether the desktop is free — one phone at a time means the way in
and the way out are never both on offer. A live pairing code appears at the top
with its countdown; a closed firewall port appears with the exact `ufw`
command and nothing that runs it for you.

The panel never talks to the daemon over the network. The daemon publishes one
file — `~/.local/state/omarchy-connect/status.json` — and rewrites it, whole
and atomically, whenever anything changes; the panel watches that file, so it
updates as fast as the daemon does without polling, and still describes the
desktop while the daemon is stopped. Every button shells out to the same CLI a
person would use, invoked through the `exec` path recorded in that file rather
than through `$PATH`, so a daemon running out of a checkout works uninstalled.

See [`shell/README.md`](shell/README.md) for the keyboard map, the IPC verbs,
and the two settings.

> Installing or updating a shell plugin hot-reloads every plugin in the running
> shell — including the lock screen. Do not do it while the session is locked;
> `omarchy-shell lock isLocked` answers before you find out the hard way.

## Messages and calls

An Android phone can hand its incoming SMS and call state to the desktop, where
they arrive as ordinary notifications — a ringing phone is raised as urgent, and
so is a call nobody picked up.

This is the one feature that needs a real build. Expo Go cannot hold the SMS
permissions, so the code lives in a local Expo module under
[`app/modules/omarchy-telephony`](app/modules/omarchy-telephony) and comes to
life only in a build of your own:

```bash
cd app
npx expo run:android          # or: eas build --profile preview --platform android
```

Then open **Settings → Messages and calls** in the app and grant the permission.
Nothing is read until you do.

There is a third switch on that card, **Show who is calling**, and it is worth
knowing why it exists. Android stopped putting the caller's number in the call
broadcast for anything targeting API 29 or higher — no permission brings it
back, and the call log is only written once the call is over. So a mirrored
call would say `unknown` for exactly as long as the phone is ringing, which is
the only time it matters. The dialler does know, and puts the contact's name on
a notification; granting notification access lets the app read it off there.
Call notifications are the only ones it looks at.

That gets you the number. Turning it into a name is the contacts permission,
which is a separate decision and a perfectly reasonable one to decline — the
card says which of the two is missing, because from the desktop a bare number
looks exactly like a caller ID that does not work.

One more thing worth knowing on Android 13 and newer: a build you installed
yourself, rather than from a store, has notification access greyed out with
*Restricted setting*. It is not broken. Open **Settings → Apps → Omarchy
Connect**, tap the menu in the corner, and choose **Allow restricted
settings** — installing with `adb install` avoids the block entirely.

iOS has no equivalent *in an app* and never will — Apple gives no app access to
messages or the call log — so the card offers the road that does work instead of
a button that cannot: see [On an iPhone](#on-an-iphone).

Replying goes the other way round. The desktop has no radio, so
`omarchy-connect sms` hands the instruction to the phone and waits for the phone
to say what happened:

```bash
omarchy-connect sms +15551234567 'on my way'
omarchy-connect phone            # what has been mirrored so far
```

> A message that lands while the app is closed still arrives, by one of two
> roads. With the **background link** on — Settings → Background link, and the
> default for a newly paired phone — a foreground service keeps the socket and
> the app's timers alive through sleep, a swipe-away and a reboot, and the
> message is forwarded as it lands. With it off, Android still starts the app's
> process for the broadcast and the native receiver writes the message into a
> small on-device backlog, which the app forwards the next time it is opened.
>
> The background link costs a permanent, silent notification — that is the
> price Android charges for a process that stays alive, and it is the switch
> that decides whether this phone exists on the desktop when it is in your
> pocket. iOS has no equivalent: the socket is taken away seconds after the app
> leaves the screen.

## Answering calls

Two entirely different roads lead to the same `omarchy-connect call answer`,
and which one you are on decides whether you can actually talk.

### Over Bluetooth — the one that carries your voice

Pair the phone with the desktop the ordinary way, in Bluetooth settings, and
make sure **phone-call audio** is enabled for it on the phone's side (Android
calls it *Phone calls*, iOS just *Bluetooth*). The desktop then looks like a car
stereo to the handset — the Hands-Free Profile, which has existed for this exact
purpose since long before any of us had a smartphone.

That gets you the whole thing: the phone rings, the desktop raises a
notification with **Answer** and **Decline** on it, and the conversation comes
out of your speakers and back through your microphone.

Not every handset holds up its end of that. The profile has a way to describe a
call in progress, and a phone is free to connect, carry the audio and never use
it — PipeWire then publishes an audio gateway with no calls under it, and the
desktop learns that the phone is ringing from the app instead. Answering still
works; the audio is the part that stays on the handset. `omarchy-connect call
status` names the road each way, and the panel's call card says which one is
about to be taken before you press anything.

### Where the buttons are

**Answer** and **Decline** are drawn by whatever is showing your notifications,
and not every notification server draws action buttons — Omarchy's own shell
does not. Where there are no buttons, **clicking the notification answers the
call**, and the notification says so. Declining is then the panel's call card,
which carries both buttons whatever the server does, or:

```bash
omarchy-connect call status      # is a handset connected, and where is the audio
omarchy-connect call answer
omarchy-connect call reject
omarchy-connect call hangup
omarchy-connect call dial +15551234567
omarchy-connect call tones 1234#     # for the phone trees nobody escapes
```

No app is involved and no permission is granted. **This works on iPhone** —
Apple will not tell an app about your calls, but it will happily tell a
hands-free unit. The same reasoning, taken one step further, is what the
[iPhone chapter](#on-an-iphone) below is about.

Nothing needs configuring on the Omarchy side. PipeWire 1.4 and later publish
the hands-free control surface on D-Bus as `org.pipewire.Telephony`, the
`hfp_hf` role is on by default, and the daemon drives it from there. If
`call status` says *unsupported*, PipeWire is older than 1.4.

> Some handsets connect but leave the audio on the handset until something asks
> for it. `omarchy-connect call audio` opens the link explicitly. It is a
> separate verb rather than something `answer` does on every call, because on a
> phone that behaves normally it is unnecessary.

### The link looks after itself

None of the above is worth much if the phone is merely *paired* when it rings.
A hands-free profile that is not connected publishes nothing, answers nothing
and carries nothing — and remembering to connect the phone every time you sit
down is exactly the kind of chore that ends with the feature unused.

So the desktop does it. **While the phone is on the network the link is held
open**, and it goes down again when the phone leaves. Nothing to configure and
nothing to press: the app appearing is the signal, and the profile is up
roughly a second later.

Two details make that cheap rather than intrusive. Only the hands-free profile
is raised — never the whole device — so the desktop does not quietly become
your phone's speaker, and whatever you had A2DP doing stays where you put it.
And a link the daemon did not raise is never one it hangs up: connect the phone
yourself in Bluetooth settings and it stays connected, whatever the policy says.

If a call does arrive with the link down — the app is closed, the phone was
asleep, you walked in mid-ring — the daemon pages the handset the moment the
ring is reported and answers over Bluetooth if it gets there in time. Measured
here, BlueZ takes about 1.6 seconds to reach a bonded handset and PipeWire a
further quarter-second to publish the gateway, against a phone that will ring
for thirty. `call answer` waits a few seconds for that page rather than
silently taking the app's road and leaving the conversation on the handset.

```bash
omarchy-connect call auto presence   # hold the link while the phone is here (default)
omarchy-connect call auto ring       # raise it only when something rings
omarchy-connect call auto off        # leave the link entirely to you
omarchy-connect call connect         # …and the hand crank, either way
omarchy-connect call disconnect
```

With more than one handset paired the desktop declines to guess, says so, and
lists what it found; `omarchy-connect call handset <address>` settles it, and
`handset auto` hands the choice back.

### Through the app — the one that only presses the button

If the phone is on the network but not paired over Bluetooth, the daemon falls
back to asking the Android app, which answers through `TelecomManager`. Grant
**Allow answering from the desktop** in Settings → Messages and calls; it is a
separate permission from mirroring, because picking up someone's call is not a
passive act.

The call is answered — but the audio stays on the handset. Android has refused
non-system apps access to call audio since Android 10, so no app can move a
conversation to your desktop, and this one does not pretend to. `call answer`
says which road it took, and warns you when it took this one.

Rejecting needs Android 9, answering Android 8.

## On an iPhone

Everything above works on an iPhone except the parts that need to read the
phone: messages, the call log, and notifications. That is not a gap in the app
and no amount of work would close it — iOS publishes none of the three to any
app, including the one you install yourself. There is no permission to ask for.

It publishes all three, in full, to a **Bluetooth accessory**. That is how a
watch knows who is calling and what the message said. So the iOS half of this
project is not in the app at all; it is in the daemon, and it needs nothing
installed on the phone.

```bash
omarchy-connect ios pair       # 2 minutes of being discoverable
omarchy-connect ios status
```

Then on the phone: **Settings → Bluetooth**, tap the desktop, Pair. iOS asks
whether to show notifications on it — say yes. That prompt *is* the feature.

From then on the desktop sees, live and with no app running:

- **Messages** — sender and text, from Messages, WhatsApp, Telegram, Signal and
  anything else that raises a notification.
- **Calls** — ringing, ended and missed, with the caller's name off the contact
  card rather than a bare number.
- **Everything else** — every app notification the phone raises, mirrored as a
  desktop notification and kept in the panel's history.

### What each Bluetooth link is for

An iPhone paired with the desktop speaks over two profiles at once, and they
carry different halves of the same thing:

| | Hands-free (classic) | ANCS (low energy) |
| --- | --- | --- |
| Call audio through your speakers | ✅ | ❌ |
| Answer and decline | ✅ | ✅ |
| Who is calling | the number | **the contact's name** |
| Messages and their text | ❌ | ✅ |
| App notifications | ❌ | ✅ |

The daemon uses both and folds them together: one ringing phone becomes one
entry carrying the number from one link and the name from the other, not two.
Answering prefers hands-free, because that is the link that moves the audio —
pressing the button over ANCS works, but leaves the conversation on the handset.

### The parity table, honestly

| | Android | iPhone |
| --- | --- | --- |
| Stats, remote, touchpad, clipboard, files, themes | ✅ | ✅ |
| Notifications desktop → phone | ✅ | ✅ |
| Battery reported to the bar | ✅ | ✅ |
| Incoming messages → desktop | app | **Bluetooth LE** |
| Calls → desktop | app + Bluetooth | **Bluetooth** |
| Answer / decline from the desktop | app + Bluetooth | **Bluetooth** |
| Call audio on the desktop | ✅ | ✅ |
| Phone's app notifications → desktop | ❌ | ✅ |
| **Send** an SMS from the desktop | ✅ | ❌ |

Two rows are worth reading twice. The iPhone is *ahead* on app notifications,
because ANCS carries everything the phone raises while the Android build only
mirrors SMS and calls. And it is behind on exactly one thing: sending. Reading
a message is a notification and iOS gives us those; writing one is an API and
iOS gives that to nobody. `omarchy-connect sms` therefore needs Android, and
there is no workaround worth pretending about.

### If it does not connect

`omarchy-connect ios status` distinguishes the cases. *unavailable* means BlueZ
is not running. *not paired* means the phone has never bonded over low energy —
run `ios pair` again and watch for the notifications prompt; declining it bonds
the phone but gives nothing away, and the row will read *idle*. Some Bluetooth
adapters — Realtek dongles especially — bond happily and then never deliver the
service; an Intel adapter is the reliable case.

## Coding agents

A phone can read the coding agent already open on this desktop — what it is
doing, what it ran, and, the part that earns the feature, the moment it stops
and waits for you to answer something — and then answer it.

```bash
omarchy-connect agent enable          # off by default, and it says why
omarchy-connect agent install-hooks   # so the desktop knows when it is stuck
omarchy-connect agent run -- claude   # start one the phone can type into
omarchy-connect agent status
```

The same switch is on the desktop panel, under **Coding agents** — with the
sessions, which of them is waiting, and a button for the hooks. It asks before
it turns on, naming what the phone is about to be able to see, and it lands
without restarting anything: the daemon writes the config and starts watching
in one call, so the phone keeps its link and its Agents screen fills where it
stands. Turning it off is one click and takes effect at once — every transcript
held open is closed, every session forgotten.

One case does need a restart, and says so rather than failing: a daemon started
before this switch existed does not know the endpoint behind it. The config is
written either way — it is what the next start reads — and both the CLI and the
panel report that what is running has not taken it:
`systemctl --user restart omarchy-connect`.

Nothing is scraped off a terminal. Claude Code already keeps every session as
JSONL under `~/.claude/projects/`, so the daemon reads the file the agent
writes for itself and collapses it into something a phone screen can carry: one
line per tool call, its full output one tap away, thinking collapsed, subagent
traffic folded away.

Sessions are found two ways. `install-hooks` adds a hook to
`~/.claude/settings.json` that reports every lifecycle event to the daemon over
loopback — that is the only road that can tell you an agent is *waiting*,
because a permission prompt leaves no trace in the transcript. Without hooks
the daemon scans `/proc` for a running agent and matches it to the newest
transcript for its working directory, which is enough to read a session that
started before any of this was installed, and is labelled as the guess it is.

Answering is the harder half, because nothing may push bytes into a terminal
another process owns. There are two roads and the app tells you which one a
session is on. Inside **tmux** the pane is tmux's own pty, so a message arrives
exactly as typed and nothing on the desktop moves — `agent run` exists to put
an agent there, attached in the terminal you started it from, so the desktop
experience is unchanged. Outside tmux the daemon falls back to **the
compositor typing on your behalf**: it remembers what was focused, focuses the
agent's window, types, and puts focus back. That one steals focus for a moment
and will interleave with anyone at the keyboard, so the app says so before the
first send. Either way the useful answer to a stopped agent is usually a single
key, which is why the composer carries `Esc`, the digits and Return above the
text field, and a raw view of the pane behind a toggle — a permission prompt is
drawn on the terminal and never written to the transcript.

**Read this before you enable it.** Reading an agent is reading everything it
saw: your source, the output of every command it ran, any secret that crossed a
tool result. Writing to one is arbitrary code execution — the agent runs what
it is told, so a phone that can type into a session has, in effect, a shell.
Both arrive with the same switch. That is a wider exposure than the clipboard
or the notification mirror, which is why it is off until you turn it on and why
both the CLI and the panel spell it out when you do. The switch is the
desktop's alone — it answers on loopback, and there is no call a phone can make
to grant itself either. The channel is encrypted end to end and only the paired
phone can ask — but pair only a phone you own.

Not every session can be answered, and the app never pretends otherwise: a
session in a terminal nothing on the desktop can reach says `reading only` and
greys its composer out rather than offering a send that would silently do
nothing. See `docs/AGENT-CONTROL.md`.

## Run the app


```bash
cd app
npm install
npx expo start
```

Scan the Expo QR with Expo Go on your phone. Everything the app uses is in the
Expo Go runtime, so no native build is needed to try it. For a standalone app,
`npx expo run:ios` / `npx expo run:android` or an EAS build.

Pairing works three ways: scan the QR from the terminal, let the app sweep the
subnet for desktops ("Find"), or type the address and code by hand.

## What the desktop needs

The daemon degrades gracefully — it reports its capabilities during the
handshake and the app greys out whatever is missing.

| Feature | Needs |
| --- | --- |
| Clipboard | `wl-clipboard` (`wl-copy`, `wl-paste`) |
| Volume / mic | `wireplumber` (`wpctl`) |
| Brightness | `brightnessctl` |
| Media keys | `playerctl`, or `wtype` as a fallback |
| Windows / workspaces | Hyprland (over its control socket; `hyprctl` is a fallback) |
| Touchpad, clicks, keys | Hyprland — nothing else to install |
| Typing arbitrary text | `wtype` |
| Scroll wheel | `ydotool` (`pacman -S ydotool`). Without it, two-finger scrolling falls back to arrow keys and the app says so. |
| Notifications | Omarchy's notification history in `~/.local/state/omarchy/` |
| Screenshot, themes, OSD | the `omarchy-*` helpers |
| Pairing QR | `qrencode` |

### Firewall

Omarchy enables `ufw` with a `DROP` input policy, so a fresh daemon listens on a
port nothing on your network can reach — the phone just times out, with no hint
on either side. Check it with:

```bash
omarchy-connect firewall
```

If it reports the port as unreachable, it prints the exact rule to run, scoped
to your own subnet rather than the whole internet:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8765 proto tcp comment 'omarchy-connect'
```

`omarchy-connect start` performs the same check and says so before it prints the
pairing code. Testing through Expo Go needs the Metro port open too
(`8081`); that one is worth removing again afterwards with `sudo ufw delete
allow …`.

### DNS switching

`omarchy-dns` rewrites a NetworkManager drop-in, so it needs root. The daemon
calls it with `sudo -n` and reports a clear error when no rule exists. To make
the DNS buttons live:

```bash
echo "$USER ALL=(root) NOPASSWD: /usr/bin/omarchy-dns" | sudo tee /etc/sudoers.d/omarchy-connect-dns
```

Skip this if you would rather not hand that command a passwordless rule — every
other feature works without it.

## Security

LAN-only and token-authenticated, with pairing codes that expire in three
minutes and die after five wrong guesses.

The WebSocket — every command, every event, your clipboard, your notification
text — is encrypted with ChaCha20-Poly1305 under keys from an X25519 handshake,
and the desktop authenticates itself with the identity key the phone pinned at
pairing time. Sessions are forward-secret, and replayed frames are rejected.

File bodies are the one thing that channel never covered: they go over HTTP so
that the phone can stream them natively instead of pushing every byte through
JavaScript. Turning TLS on is what closes that:

```bash
omarchy-connect tls enable
systemctl --user restart omarchy-connect
omarchy-connect pair            # the new QR carries the certificate pin
```

The certificate is self-signed and minted on this machine, so no authority
vouches for it — what makes it trustworthy is that the phone pins its public key
from the pairing QR, the same way it already pins the identity key. A new DHCP
lease re-issues the certificate over the *same* key, so the pin a phone is
holding keeps matching and nobody has to pair again.

The phone has to be able to verify it, and that is where the platforms differ:

| | |
| --- | --- |
| **Android, real build** | `omarchy-connect tls trust` copies the certificate into `app/assets/desktop-ca.pem`; the bundled config plugin adds it as a build-time trust anchor next to the system ones. Rebuild and https works everywhere in the app, streaming included. |
| **Expo Go, iOS** | No way to add a trust anchor, so the app stays on http and file bodies stay in the clear on your LAN. Everything else — commands, clipboard, notification text — is still end-to-end encrypted. |

TLS is off by default, because switching it on without doing the phone half
would leave you with a daemon nothing can reach.

Pairing also grants control of the pointer and keyboard, and only one phone
holds that at a time. Only pair a phone you own. The full model is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Tests

```bash
cd daemon && npm test                   # protocol, TLS, call control, iPhone bridge
node app/test/integration.mjs           # the real app client against the daemon
```

All of them spin up a daemon on a spare port and exercise pairing, method
calls, event streaming, and credential rejection. The two Bluetooth suites go
as far as the antenna and no further — nothing in a test can make a phone ring
— so they read this machine's real D-Bus surface, construct the exact packets
the radio would deliver and split them at every awkward boundary, and stand in
for `notify-send` and `bluetoothctl` so a test run cannot throw a notification
onto your screen or put your adapter on the air.

## Layout

```
daemon/         Node.js daemon — one dependency (ws)
  src/lib/      config, crypto, TLS certificates, theme parsing, /proc
                sampling, hyprland IPC, the published status file, the
                shell-plugin installer
  src/plugins/  system, clipboard, notifications, media, desktop, share,
                input, device telemetry, SMS and calls, coding agents
  src/agents/   one adapter per coding agent — where its transcript lives and
                how to read a line of it — plus the lifecycle hooks the desktop
                installs into Claude Code's own settings, and the writer that
                types back through tmux or the compositor
  src/lib/      …including the three Bluetooth clients: hands-free call control
                over PipeWire, the BlueZ side that raises that link and keeps
                it up, and an iPhone's notifications over ANCS
shell/          Omarchy shell plugin — the desktop client (QML)
app/            Expo app (TypeScript)
  modules/      local Expo module — Android SMS and call state (Kotlin)
  plugins/      config plugin — trusts the desktop's certificate on Android
  src/api/      WebSocket client, channel crypto, discovery, secure storage,
                phone telemetry, SMS/call mirroring
  src/ui/       the card / readout / control kit
  src/screens/  stats, remote, touch, agents, share, alerts, setup, pairing
docs/           protocol specification
```

## Next

Adapters for the other coding agents — Codex, Gemini CLI — and a raw
`capture-pane` view for the ones nothing can parse; encrypted file bodies for
the platforms that cannot pin a certificate (iOS and Expo Go), so TLS is not
the only way to close that gap; wake-on-LAN so a
sleeping desktop can be woken from the couch; a real scroll wheel without
depending on `ydotool`; replying to a mirrored message from the desktop
notification itself rather than from the CLI; and drag-and-drop onto the bar
widget to send a file.

The one gap that is not on this list is sending a message from an iPhone. It is
not a matter of effort — iOS exposes no way to do it, to anyone.
