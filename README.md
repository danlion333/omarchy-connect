# Omarchy Connect

Your phone, wired into your Omarchy desktop. Live system stats, remote control,
clipboard sync and file transfer — all over your own LAN, with no account, no
cloud, and no traffic leaving the subnet.

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
| **Clipboard sync** | Whatever you copy on the desktop appears on the phone, and back. |
| **Notifications** | Whatever the phone mirrors — messages, calls, app notifications — arrives as a desktop notification. The desktop's own notifications stay on the desktop; the app does not carry an inbox. |
| **Files** | Send a file or photo from the phone to `~/Downloads/Omarchy Connect/`; push a desktop file to the phone with `omarchy-connect send <file>`. A picture arrives on the phone as a picture — thumbnail in the list, full screen on a tap, pinch to read the small print, and one more tap keeps it in the phone's own gallery. An offer the desktop is still holding is there when the app opens, not only while it was watching. |
| **Themes** | Read and switch the active Omarchy theme from the phone. |
| **DNS** | Read and switch the system DNS provider (needs a sudo rule, see below). |
| **Encryption** | X25519 key exchange, ChaCha20-Poly1305 frames, identity key pinned from the pairing QR. |
| **TLS** | Optional https + wss with a self-signed certificate the phone pins from the QR — this is what covers the file transfers too. |
| **Messages and calls** | Incoming SMS and call state from an Android phone become desktop notifications; reply with `omarchy-connect sms`. |
| **Answering calls** | Pick up or decline from the desktop — click the ringing card to answer, right-click it to decline — and over Bluetooth the conversation comes out of your speakers, with that half needing no app at all. The desktop raises that link when the phone rings and puts it back down when the call ends, so the handset spends the rest of the day off the hands-free profile. A ringing phone rings here too, and a call you picked up keeps a card on screen counting the minutes. |
| **iPhone bridge** | An iPhone mirrors its messages, calls and app notifications to the desktop over Bluetooth Low Energy, with nothing installed on the phone. |
| **Coding agents** | Read the Claude Code session already open on the desktop from your phone, answer it — including tapping an option off a multiple-choice question — and send it a screenshot from your photos, your files or your clipboard. The phone tells you the moment one stops to ask you something, and the usual one-word answer can be typed straight into the notification. It carries the desktop's own status line with it: which model, how full the context is, which permission mode, which branch — and a **compact** button that appears once the conversation is running out of room. Every skill and slash command that desktop has is a searchable list one tap from the composer, so `/security-review` costs a thumb rather than a keyboard. How much of the plan is left sits above the session list, because that is the number that decides whether starting something long is a good idea. Off by default, and switched on from the desktop — the panel or the CLI. |
| **Agents you start** | Pick up any conversation that desktop has ever had — the CLI's own `--resume`, from a list with the titles it wrote for them — or send a new agent off with a prompt and no terminal at all, and read what it did later. A background agent's own running commentary ("exploring project state for commit + merge flow") is on the phone, and nowhere else: nothing on the desktop draws it. Behind a second switch, `omarchy-connect agent spawn on`, because starting a process is not the same decision as reading one. |
| **Phone notifications** | One ongoing line saying whether this phone can currently see its desktop — the KDE Connect habit — with a reconnect button on it while it cannot. Then four things it will tell you about: an agent waiting on a question (with a reply box on the notification), an agent that finished something long, a file the desktop sent (with **Save** straight to the gallery), and whatever the desktop last copied (silent, with **Copy**). Each has its own switch. |
| **Wake on LAN** | The desktop hands the phone its MAC and broadcast address while it is still awake, so a magic packet from the sofa brings it back out of sleep. Android only — nothing in Expo Go or on iOS can send the packet. |
| **Follows the desktop** | If the router hands the desktop a new address, the phone finds it again by its pinned key instead of asking you to re-pair. |
| **Desktop client** | An Omarchy bar widget and panel: one line saying whether the phone is linked and what it is doing, whatever has just happened, and one click each to pair, send a file, or open the inbox. The counters and the two switches fold away until you ask for them. |

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
omarchy-connect call bond [stop]            pair a handset over Bluetooth from here
omarchy-connect call auto <presence|ring|off>  when to hold the Bluetooth link open
omarchy-connect call ringtone <on|off|FILE>  what a ringing phone sounds like here
omarchy-connect call timer <on|off>         count the conversation on screen
omarchy-connect ios <status|pair|stop>      mirror an iPhone over Bluetooth LE
omarchy-connect phone [--limit N]           mirrored messages and calls
omarchy-connect agent <status|enable|spawn|run|…>  read, answer and start coding agents
omarchy-connect tls <status|enable|…>       serve https + wss with a pinned certificate
omarchy-connect config [key] [value]        read or change configuration
omarchy-connect firewall                    check the port is reachable
omarchy-connect wake                        whether a phone could wake this desktop
omarchy-connect panel <status|install|remove>  the Omarchy bar client
omarchy-connect install-service             write a systemd user unit
```

`pair --wait` holds the QR code on screen until a phone uses it or the code
expires, which is why the desktop client drives it from a floating terminal.
`send --pick` opens the GTK file chooser instead of taking a path.

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
icon (or `omarchy-shell omarchy-connect toggle`) for the panel.

What it draws without being asked is short on purpose: the phone's name, one
line saying whether the link is encrypted, how long it has been up and what
battery is behind it — and then only things that have actually happened. A live
pairing code with its countdown. A ringing call with Answer and Decline. A
closed firewall port with the exact `ufw` command and nothing that runs it for
you. A coding agent that has stopped to ask you something. Messages and files
that just arrived. Then three buttons: Pair *or* Unpair depending on whether
the desktop is free — one phone at a time means the way in and the way out are
never both on offer — then Send and Inbox.

Everything else sits behind two collapsed rows. **Details** holds the
transport, the address and the identity fingerprint, plus whichever counters
and Bluetooth links have anything to report — a desktop paired to an Android
phone is not told that no iPhone is paired, and a link that has moved no files
is not shown two zeroes; **Settings** holds the two switches that get decided
once a year —
whether the phone may read the coding agents here, and whether the daemon comes
up at login. Both start shut every time the panel opens.

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
>
> That notification earns its place by being a status line rather than a
> receipt: it says **Connected to `<desktop>`** only while the socket is
> actually up, and otherwise names the desktop, says what the link is doing —
> connecting, reconnecting, the error it hit — and carries a **Reconnect**
> button for the moment you walk back into the flat and would rather not wait
> out the backoff.

## Being told an agent is waiting

An agent that has stopped on a permission prompt is idle until a person answers
it. On the desktop that is obvious; with the phone in a pocket it is invisible,
which is the whole reason this is a notification rather than the badge on the
tab bar it used to be.

When a session on the desktop enters the waiting state, the phone raises an
alert with the question on it and a **Reply** box in the notification itself —
so the ordinary answer never needs the app opened at all. Tapping the
notification opens *that* conversation rather than the app's last screen.

The rules it keeps:

- **One alert per question.** The desktop re-sends session state freely; the
  phone buzzes when an agent *enters* the waiting state, and silently corrects
  the wording if the question changes under it.
- **Nothing about a session on screen.** Reading the chat is being told.
- **The alert dies with the question.** Answered from the phone, from the
  desktop, or by the agent giving up — the card goes either way.
- **No reply box it cannot honour.** A session the desktop has no way to type
  into gets an alert without one.

An answer typed into the shade is written to an on-device backlog *before*
anything tries to send it, so it survives the phone having no socket at that
moment — after a reboot, or once Android has torn the JavaScript runtime down
under the service. It goes out at the next `hello`, and the notification says
whether it was sent. Nothing is retried behind your back: an answer arriving at
an agent that has since moved on is worse than one that never came.

Switched off under Settings → Notifications, and Android-only for the same
reason the background link is — see the note above.

## The other three things the phone will say

The same machinery, at three lower volumes. Each is a separate switch under
Settings → Notifications, because the four are not the same favour: being told
an agent is waiting is worth a sound at midnight, and being told the desktop
copied a word is worth a line at the bottom of the shade and nothing more.

- **An agent finished.** Only when it had been working for at least a minute.
  Every turn an agent takes ends idle, so notifying on all of them would be a
  reason to switch the feature off; the threshold is what makes it mean "the
  thing you walked away from is done". The card comes down by itself if that
  agent starts working again.
- **A file arrived.** `omarchy-connect send <file>` used to put an offer up and
  wait to be discovered. Now the phone says so, and for a picture or a video
  the notification carries a **Save** that fetches the file and files it in the
  gallery with the app never opened — the download and the save both run in the
  background service. Anything else is a tap through to the share screen,
  because "save" for an arbitrary file means choosing where, and that is a
  conversation rather than a button. On Android 12 and older, writing to the
  library needs a permission that cannot be asked for without a screen; there
  the notification says so and the app is one tap away.
- **The desktop copied something.** Silent, and one notification that keeps
  replacing itself — a desktop clipboard is a single thing, and a phone that
  pinged on every Ctrl+C would be uninstalled by lunchtime. **Copy** is handled
  entirely on the phone: writing the clipboard needs no socket and no app on
  screen, so the text is one tap from being pasteable. Nothing is said at all
  while the app is open, where the share card is already showing it.

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
call** and **right-clicking it declines**, and the notification says so. The
right button is not an action a notification can carry: it is the gesture that
sweeps a card off the screen, and the desktop reads it off the bus — a card
closed by a person's hand, as opposed to one that timed out or one the desktop
closed itself, is somebody saying no to the call. Both are also on the panel's
call card, which carries the two buttons whatever the server does, or:

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

### The link exists while a call does

None of the above is worth much if the phone is merely *paired* when it rings.
A hands-free profile that is not connected publishes nothing, answers nothing
and carries nothing — and remembering to connect the phone every time you sit
down is exactly the kind of chore that ends with the feature unused.

But the opposite chore is real too, and it is the one you actually notice: a
handset left on the hands-free profile is a handset held in a narrowband voice
codec all day, with the desktop's own output dragged along beside it. BlueZ
raises that link on its own the moment a bonded phone is in range — at login,
after every reconnect — so "leave it up" is not a decision anybody made, it is
just what happens.

So the default is **the link goes up for a call and comes down after it**. The
daemon pages the handset the moment a ring is reported, answers over Bluetooth
if it gets there in time, and drops the profile fifteen seconds after the line
clears — long enough that a call ending because the other side is ringing
straight back does not pay for a second page. A link that was already up when
the daemon started, or that BlueZ raised behind its back, is put back down the
same way: idle, under this policy, means it should not be there.

Measured here, BlueZ takes about 1.6 seconds to reach a bonded handset and
PipeWire a further quarter-second to publish the gateway, against a phone that
will ring for thirty. `call answer` waits a few seconds for that page rather
than silently taking the app's road and leaving the conversation on the
handset.

Three details keep that from being intrusive. Only the hands-free profile is
raised or dropped — never the whole device — so the desktop does not quietly
become your phone's speaker and whatever you had A2DP doing stays where you
put it. A link somebody asked for by hand is never one the daemon hangs up.
And a handset that insists on re-raising the profile wins: after the third
time in a minute the desktop stops arguing and says so in the log.

```bash
omarchy-connect call auto ring       # up for a call, down after it (default)
omarchy-connect call auto presence   # hold it open while the phone is here
omarchy-connect call auto off        # leave the link entirely to you
omarchy-connect call connect         # …and the hand crank, either way
omarchy-connect call disconnect
```

The hand crank is on the panel too, under *Details*: the **Bluetooth** row
names the matched handset and says whether the link to it is up, and the button
beside it raises or drops it. Dropping it leaves the bond alone — the phone
stays in the machine's Bluetooth list and comes back up on the next ring — so
the only thing the button ever changes is whether the profile is currently
carrying anything.

`presence` is the trade in the other direction: the profile is up for as long
as the app is on the network, so a ringing call is answerable instantly and
never spends its first second on a page — at the cost of the phone wearing the
hands-free profile the whole time it is in the room.

### The ring

A notification card is the wrong instrument for a call. Answering from the
desktop earns its keep exactly when the handset is in another room, and
something you have to be looking at the screen to notice does not survive
that — so a ringing phone rings here too, on a loop, until the call is
answered, declined or rings out.

It is the desktop's own sound theme by default, which is one less file to
carry and the sound the rest of the system already uses for this. Point it at
anything you would rather hear:

```bash
omarchy-connect call ringtone ~/Music/ring.ogg
omarchy-connect call ringtone test      # play it once
omarchy-connect call ringtone default   # back to the sound theme
omarchy-connect call ringtone off
```

Handsets that send their own ringing tone down the audio link once it opens
take over from ours the moment they do: two ringtones at once is worse than
either, and theirs is the one in step with the call.

### Which handset

The two halves of this pair separately — one over the LAN with a QR code, one
in Bluetooth settings — and for a while nothing joined them up. The Bluetooth
half looked at everything the machine was bonded to and asked "is there exactly
one thing here that could be a phone?", which on a laptop that has ever been in
a car is a question with no answer: a car kit, two sets of earbuds, a phone,
and the desktop declines to guess.

It does not have to ask. By the time any of this matters the desktop has
already been told which phone is *its* phone, by the phone itself, during the
pairing everybody does first. So the handset the LAN knows about is the handset
Bluetooth reaches for, and the ambiguity stops being one.

The join is made on the name, because that is the only identifier both sides
publish. It would be nicer to use the address, and the phone cannot give it:
Android has answered `BluetoothAdapter.getAddress()` with the constant
`02:00:00:00:00:00` for every ordinary app since Android 6, and the permission
that lifts that is signature-only. The name is a better key than it sounds —
the app reports the phone's device name and BlueZ's alias is that same device
name, so on an untouched handset they are not merely similar but identical.
Punctuation and case are ignored, and one being longer than the other is fine,
so `OnePlus_9_Pro` still matches `OnePlus 9 Pro 5G`.

Where it will not stretch is a handset renamed past recognition in one place
and not the other, or two bonds under the same name. Guessing wrong is worse
than not guessing — connecting to the car instead of the phone is a failure you
have to diagnose, where a refusal is one you can read — so the desktop says
what it could not decide and `omarchy-connect call handset <address>` settles
it. `handset auto` hands the choice back.

`call status` says which of the three answers it is using, because "this is the
phone you paired" and "this was the only thing on the list" are different
promises and only one of them survives buying a pair of earbuds:

```
HANDSET     OnePlus 9 Pro 5G · your paired phone
```

### The clock

Answering from the desktop takes the phone out of your hand — and the call
timer with it. The handset keeps counting on a screen nobody is holding, and
the desktop used to say nothing at all: the panel says *in progress*, and only
while the panel is open.

So the card that was ringing stays up, and counts. It is the same card — the
notification is rewritten in place once a second rather than closed and raised
again, so picking up looks like one notification changing its mind rather than
two taking turns. It never expires on its own, it interrupts nobody (the ring
was urgent, this is not), and when the call is over it leaves the total behind
it for a few seconds: *lasted 4m 12s* — the number you reach for a minute later
and would otherwise have to go into the phone to find.

The bar stays one glyph through all of it. It says *who* you are talking to in
its tooltip and leaves the counting to the card — a clock beside the bar icon
grew and shrank a digit at a time and pushed everything to its left along with
it, for a number that was already on screen a few centimetres away. The panel's
call card counts as well, for as long as it is open.

```bash
omarchy-connect call timer off   # leave the screen alone during a call
omarchy-connect call timer on
```

Switching it off mid-conversation takes the card down there and then. The panel
still knows when the call started either way — the switch is about the
notification, not about the clock.

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
| Stats, remote, clipboard, files, themes | ✅ | ✅ |
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

The same switch is on the desktop panel, under **Settings** — with a button for
the hooks beside it, and the sessions themselves, including which of them is
waiting, on the panel proper. It asks before
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

The scan is careful about two things, because both were wrong once and both
looked like the same complaint — *the list does not match what is on the
screen*. A `claude` in `/proc` is not necessarily a session: the agent runs its
own supervisor and its own pty hosts under the same name, and one of them was
being listed as an agent with a stranger's conversation inside it. And a
transcript that stopped changing before its supposed author started is not that
author's — on a desktop where sessions come and go all day the newest file in a
directory is usually one that ended, so a live pid was being pinned to a dead
conversation. An agent that has not written its first line yet is therefore
absent for those few seconds rather than misattributed, and appears on its own
once it writes.

A working directory is not a unique key either. A background agent and the
session that launched it share one, and the transcript follows the agent
between project directories a beat after it moves — long enough for the
background agent's conversation to be listed under the interactive session's
pid, with that session's terminal offered as the way to answer it. So the two
have to agree about what kind of session they are: a process with a controlling
terminal is one somebody is sitting at, the transcript records which it was,
and a mismatch is not a pair.

A session also leaves the list when its process does — killed, closed, or
rebooted away — within one scan, whichever road found it. What a background
agent gets is a read: it is a real conversation worth following from the sofa,
but it sits in no terminal anybody is typing at, so the app offers no composer
for it rather than typing into whichever window happens to be up the process
tree.

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

When what stopped it is a **multiple-choice question**, there is no counting
digits. That kind of question is a tool call, so it is in the transcript, and it
is the one call that reaches the phone whole rather than collapsed to a line:
the question, every option, and what each one means. Tap the one you want. The
number beside it is the key the desktop is about to press, drawn where the
terminal draws it, so what you tap and what the agent gets are visibly the same
thing — and because the desktop checks the option against the question it
actually asked, a screen that has gone stale gets a refusal rather than
answering the next prompt by accident. Answer it at the keyboard instead and the
card settles on the phone by itself. This is also the one road to *waiting* that
needs no hooks at all: a session found by scanning can now say it is stuck, and
say what on.

You can also **send it a picture** — from your photos, from your files, or
straight off the clipboard, which is where a screenshot is a second after you
cropped it. The desktop keeps the file in a swept cache directory and hands the
agent its path, because a terminal carries text and nothing else and an agent
reads an image by opening it. It never touches `~/Downloads/Omarchy Connect`
and raises no notification: a screenshot attached to a question is scaffolding
for that question, not a file you meant to keep. Pick it while you write the
caption and it is already across by the time you press send.

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
| Pointer, clicks, keys (`input.*`, protocol only — no screen in the app) | Hyprland — nothing else to install |
| Typing arbitrary text | `wtype` |
| Scroll wheel (`input.scroll`) | `ydotool` (`pacman -S ydotool`). Without it, scrolling falls back to arrow keys and says so. |
| Notification history (`notifications.*`, protocol only) | Omarchy's notification history in `~/.local/state/omarchy/` |
| Screenshot, themes, OSD | the `omarchy-*` helpers |
| Pairing QR | `qrencode` |
| Browsing for a file to send (`send --pick`) | the XDG desktop portal (`xdg-desktop-portal` plus a backend) — the file chooser a browser opens. Without one, pass the path: `omarchy-connect send <file>`. |
| Waking it from the phone | a wired card set to wake the machine — `omarchy-connect wake` says whether yours is, and prints the command |

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

### Wake on LAN

A desktop that is asleep runs no daemon, so nothing can be asked of it at the
moment it is wanted. The answers are handed over earlier instead: every `hello`
carries this machine's MAC, the broadcast address of its subnet and whether its
card is set to wake it, and the phone keeps that copy beside the pairing. The
button is on the Remote screen, under Sleep, and it is the one control there
that comes alive when the desktop does not answer.

Check the desktop half with:

```bash
omarchy-connect wake
```

It reads the card's own wakeup flag — no root, nothing changed — and if the
card is not armed it prints the command that arms it for good:

```bash
nmcli connection modify "Wired connection 1" 802-3-ethernet.wake-on-lan magic
```

NetworkManager is the road worth taking because it re-applies the setting every
time the link comes up; `sudo ethtool -s enp8s0 wol g` does the same thing until
the next reboot and then quietly stops. The other half is in the BIOS — usually
"Wake on LAN" or "Power on by PCI-E" — and no command here can read or set it.

Two honest limits. Wi-Fi cards almost never wake a machine from a magic packet,
so this is a feature for a wired desktop. And the phone needs a UDP socket,
which the React Native runtime does not have — the packet goes out through this
project's own Android module, so waking works in the Android build and nowhere
else.

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
                over PipeWire, the BlueZ side that raises that link for a call
                and puts it down after, and an iPhone's notifications over
                ANCS — plus the ring a call makes on the desktop's speakers,
                and the card that counts while one is up
shell/          Omarchy shell plugin — the desktop client (QML)
app/            Expo app (TypeScript)
  modules/      local Expo module — Android SMS and call state (Kotlin)
  plugins/      config plugin — trusts the desktop's certificate on Android
  src/api/      WebSocket client, channel crypto, discovery, secure storage,
                phone telemetry, SMS/call mirroring
  src/ui/       the card / readout / control kit
  src/screens/  stats, remote, agents, share, setup, pairing
docs/           protocol specification
```

## Next

Adapters for the other coding agents — Codex, Gemini CLI — and a raw
`capture-pane` view for the ones nothing can parse; encrypted file bodies for
the platforms that cannot pin a certificate (iOS and Expo Go), so TLS is not
the only way to close that gap; a real scroll wheel without
depending on `ydotool`; replying to a mirrored message from the desktop
notification itself rather than from the CLI; and drag-and-drop onto the bar
widget to send a file.

The one gap that is not on this list is sending a message from an iPhone. It is
not a matter of effort — iOS exposes no way to do it, to anyone.
