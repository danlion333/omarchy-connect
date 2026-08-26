# Omarchy Connect protocol v2

A phone talks to one Omarchy desktop over the local network. One HTTP server
carries both a small REST surface and the WebSocket that does the real work.
The WebSocket is encrypted end to end and the desktop authenticates itself with
a key the phone pinned when it paired.

```
phone ──── ws://<desktop>:8765/ws ───► daemon ──► plugins ──► omarchy-* / wpctl / hyprland
      ◄─── events (stats, clipboard, notifications, theme, files)
           every frame ChaCha20-Poly1305, keys from an X25519 handshake
```

Everything is LAN-only: nothing leaves the subnet, there is no cloud account,
and the daemon never dials out.

## Encryption

The desktop owns a long-lived X25519 identity key, generated on first run and
kept in the 0600 config. Its digest is what `omarchy-connect status` prints and
what the app shows under Setup — the two should match.

Before any JSON crosses the socket, the two ends run a handshake modelled on
Noise IK:

```
phone   → desktop    "OCX1" || e_pub        36 bytes, binary
desktop → phone      "OCX1" || f_pub        36 bytes, binary

es = X25519(e, S)        S is the desktop's pinned identity key
ee = X25519(e, f)        both ephemerals are discarded with the socket
k  = HKDF-SHA256(es || ee, salt = e_pub || f_pub, info = "omarchy-connect v1 channel", 64)
```

The first 32 bytes of `k` encrypt phone → desktop, the last 32 desktop → phone.
Every later frame is binary ChaCha20-Poly1305 over the JSON that v1 sent in the
clear.

Three properties follow, and each is exercised by the test suites:

- **The desktop is authenticated.** `es` needs the identity private key, so a
  machine that answers on the right address but cannot prove it holds that key
  never produces a readable frame. The phone hangs up.
- **Sessions are forward-secret.** `ee` mixes two ephemerals that are thrown
  away when the socket closes, so stealing the identity key later does not
  decrypt traffic recorded earlier.
- **Frames cannot be replayed or reordered.** The nonce is a per-direction
  counter that never travels on the wire; a repeated or out-of-order frame
  simply fails to authenticate, and the daemon drops the connection.

A socket that opens with a text frame instead of a key exchange is refused with
close code `4005` unless `requireEncryption` is turned off in the config.

## Transport

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/info` | GET | none | Discovery probe. Returns name, version, protocol, active theme, identity key. |
| `/api/pair-code` | POST | localhost | Mints a 6-digit pairing code (used by the CLI). |
| `/api/offer` | POST | localhost | `omarchy-connect send <file>` offers a file to phones. |
| `/api/sms` | POST | localhost | Asks the paired phone to send an SMS; answers when it confirms. |
| `/api/call` | POST | localhost | Answers, rejects, hangs up or places a call, over Bluetooth or through the app. |
| `/api/ios` | POST | localhost | Opens or closes the window in which an iPhone will agree to mirror its notifications. |
| `/api/upload` | POST | token | Phone → desktop file transfer. Streams to the inbox. |
| `/api/download/<token>` | GET | token | Desktop → phone file transfer for an offered file. |
| `/ws` | WS | handshake | Everything else. |

Everything above is served over plain HTTP unless TLS is switched on, in which
case the same paths are served over https and `/ws` becomes `wss`. There is no
mixed mode: a daemon serving TLS answers nothing at all on http, so a client
that has not pinned the certificate finds a silent port rather than a downgrade.

`/api/info` is deliberately unauthenticated and cheap: the app finds desktops by
probing the subnet for it. It exposes no user data beyond the host name, the
theme palette and the public half of the identity key. The app also uses it to
follow a desktop that changed address — it re-scans the subnet and reconnects to
whichever host presents the key it already pinned.

## TLS

Off by default; `omarchy-connect tls enable` turns it on.

The certificate is self-signed, minted with `openssl` into
`~/.config/omarchy-connect/tls/` (key mode 0600), and covers `localhost`, the
host name, `127.0.0.1` and every IPv4 address the machine currently holds. No
authority vouches for it — the phone pins it instead, by the base64 SHA-256 of
its SubjectPublicKeyInfo, the same shape as an HPKP or OkHttp pin.

The pin travels in the pairing QR (`s=1&t=<pin>`) and is published by
`/api/info` as `{ "tls": true, "certPin": "…" }`.

Two properties matter and are both deliberate:

- **A new address re-issues the certificate over the same key.** The SANs have
  to name the address the phone is dialling, and a DHCP lease changes that — but
  re-minting with the existing key leaves the pin untouched, so the swap is
  invisible to every paired phone. The daemon does this itself on a lease
  change, through `setSecureContext()`, without dropping connections.
- **A new key is never minted implicitly.** `omarchy-connect tls rotate` is the
  only thing that changes the pin, and it says out loud that every phone has to
  pair again.

Verification is the phone's problem, and the platforms differ: an Android build
can carry the certificate as a build-time trust anchor
(`omarchy-connect tls trust` plus the bundled config plugin), while Expo Go and
iOS have no way to add one and stay on http.

## Pairing

1. The desktop mints a code: `omarchy-connect pair` (or the daemon prints one at
   startup when no device is paired yet).
2. The terminal renders a QR encoding
   `omarchy-connect://pair?h=<ip>&p=<port>&c=<code>&n=<name>&k=<identity key>`,
   plus `&s=1&t=<certificate pin>` when the daemon is serving TLS.
3. The phone pins `k`, runs the key exchange, and sends the code in its `hello`.
4. The daemon replies with a 32-byte token, stored in the phone's secure
   storage and in `~/.config/omarchy-connect/config.json` (mode 0600).

Reading the key off the screen rather than off the network is what makes this a
verified pairing rather than trust-on-first-use. When the address is typed by
hand there is no QR, so the app reads the key from `/api/info` and displays its
fingerprint for the person to compare against the terminal.

Codes live for 3 minutes and die after 5 wrong guesses. Codes and tokens are
compared in constant time. The token is the only credential afterwards — revoke
it with `omarchy-connect unpair <name>`.

## WebSocket messages

Every frame is a JSON object with a `t` (type) field.

### Handshake

All of the frames below travel inside the encrypted channel described above.

```jsonc
// phone → desktop, first JSON frame, within 10s of connecting
{ "t": "hello", "token": "…", "device": { "id", "name", "platform", "model" } }
// or, when pairing:
{ "t": "hello", "pairCode": "123456", "device": { … } }

// desktop → phone, only while pairing
{ "t": "paired", "token": "…", "device": { … } }

// desktop → phone
{ "t": "hello.ok", "protocol": 2, "secure": true, "fingerprint": "9AD3-E65B-D149-638A",
  "server": { "name", "version" }, "device": { … }, "host": { … },
  "capabilities": { … }, "theme": { … }, "events": [ … ] }

// desktop → phone, then the socket closes
{ "t": "hello.err", "error": "wrong pairing code" }
```

`capabilities` reports what this particular machine can actually do — whether
`wpctl`, `brightnessctl`, `playerctl`, `hyprctl` and the `omarchy-*` helpers are
installed. The app greys out what is missing instead of failing at call time.

### Requests

```jsonc
{ "t": "req", "id": 7, "method": "volume.set", "params": { "percent": 35 } }
{ "t": "res", "id": 7, "ok": true, "data": { "output": { "percent": 35, "muted": false } } }
{ "t": "res", "id": 7, "ok": false, "error": "wpctl not installed" }
```

### Events

```jsonc
{ "t": "sub", "events": ["stats", "clipboard", "notification", "theme", "file", "phone", "agent"] }
{ "t": "ev", "event": "stats", "data": { … } }
```

Subscriptions are reference-counted: the 1 Hz stats sampler only runs while at
least one phone is subscribed.

| Event | Fires when |
| --- | --- |
| `stats` | Every second — CPU, memory, disk, battery, network, latency. |
| `clipboard` | The desktop clipboard changes (text only, ≤256 KB). |
| `notification` | Omarchy writes a new notification to its history. |
| `theme` | The active Omarchy theme changes. |
| `file` | A file arrived from a phone, or the desktop offered one. |
| `phone` | A mirrored SMS or call arrived (`action: "received"`), or the desktop is asking the phone to send one (`action: "send"`). |
| `agent` | A coding agent appeared, changed state, or said something new. |

`ping`/`pong` frames are available for round-trip measurement; the daemon also
runs a 20-second WebSocket ping and drops sockets that stop answering, because
a sleeping phone's TCP connection dies silently.

## Methods

### system

| Method | Params | Returns |
| --- | --- | --- |
| `system.stats` | — | The same payload as the `stats` event. |
| `system.info` | — | `{ host, theme }` — hostname, OS, kernel, CPU, cores, uptime. |
| `system.theme` | — | Active Omarchy palette. |
| `system.power` | `{ action, confirm }` | `lock`, `sleep`, `screensaver`, `logout`, `reboot`, `shutdown`. The last three require `confirm: true`. |
| `system.screenshot` | `{ mode, target }` | `smart\|region\|windows\|fullscreen` × `copy\|save\|slurp`. |
| `system.openUrl` | `{ url }` | Opens an http(s) URL in the default browser. Other schemes are refused. |
| `system.locate` | — | Notification plus a sound, to find the machine in a room. |

### media

| Method | Params |
| --- | --- |
| `media.state` | — → output/input volume, brightness, player metadata |
| `volume.set` | `{ percent }` (0–100, capped at 100%) |
| `volume.step` | `{ delta }` — routes through the Omarchy OSD when available |
| `volume.mute` | `{ target: "output" \| "input" }` |
| `brightness.set` / `brightness.step` | `{ percent }` / `{ delta }` |
| `player.play` / `player.next` / `player.previous` / `player.stop` | — |

### clipboard, notifications, share, desktop

| Method | Params |
| --- | --- |
| `clipboard.get` / `clipboard.set` | — / `{ text }` |
| `notifications.list` | `{ limit }` — the Omarchy notification history |
| `notifications.send` | `{ summary, body, urgency }` — phone → desktop notification |
| `share.text` | `{ text, action: "clipboard" \| "file" }` |
| `share.inbox` | `{ limit }` — files received from phones |
| `share.offers` | — files the desktop is currently offering |
| `theme.list` / `theme.current` / `theme.set` | — / — / `{ name }` |
| `hypr.workspaces` / `hypr.goto` | — / `{ id }` |
| `hypr.windows` / `hypr.focus` / `hypr.close` | — / `{ address }` |

### device

The return leg of the stats stream: the desktop tells the phone about itself
every second, and this is the phone's chance to say something back. It exists
for the desktop client, which shows the phone's charge in the Omarchy bar.

| Method | Params | Notes |
| --- | --- | --- |
| `device.report` | `{ battery: { percent, charging }, network }` | Every field optional; an absent one clears rather than freezes. `percent` is clamped to 0–100. |

Reports live in daemon memory only — restarting the daemon or unpairing the
phone forgets them, and nothing is written to the config. The phone sends one
on connect, again whenever the battery moves, and on a five-minute timer.
Desktops that want it advertise `capabilities.device.report`.

### phone

Mirroring is Android only, and only in a real build — Expo Go cannot hold the
SMS permissions and iOS exposes neither messages nor the call log to any app.
The daemon is written to be fed rather than to poll.

Call *control* is not restricted that way: see **Bluetooth** below.

Who is calling does not come from the telephony stack. Android withholds the
number from `ACTION_PHONE_STATE_CHANGED` for apps targeting API 29 or higher,
so the app reads the caller off the dialler's own call notification instead and
reports it in the same `call` event. The notification and the state change race
each other: when the name arrives first it rides on the one `ringing` event,
and when it arrives second the app sends a further `ringing` event carrying it.
The daemon folds the second into the first rather than recording the call
twice — the same fold described under *Mirroring*, which was written for an
iPhone announcing itself down two Bluetooth roads at once.

| Method | Params | Returns |
| --- | --- | --- |
| `phone.report` | `{ events: [ … ] }` | `{ ok, stored }` |
| `phone.history` | `{ limit }` | `{ items, counters, call, bluetooth, ios }` |
| `phone.sent` | `{ id, ok, error }` | `{ ok }` |
| `phone.acted` | `{ id, ok, error }` | `{ ok }` |

An event is either

```jsonc
{ "kind": "sms",  "at": 1724600000000, "from": "+1555…", "name": "Mum", "body": "dinner at eight" }
{ "kind": "call", "at": 1724600000000, "from": "+1555…", "name": null,
  "state": "ringing" | "active" | "ended", "missed": true, "direction": "incoming" }
{ "kind": "notification", "at": 1724600000000, "app": "com.apple.mobilecal",
  "appName": "Calendar", "title": "Standup", "body": "in 10 minutes" }
```

Only the first two can come from the app. The third exists because an iPhone
mirrors *everything* it raises rather than only its telephony — see
[ANCS](#ancs--the-iphones-own-notifications) — and it is recorded as its own
kind because an app notification has no correspondent: the app is the subject.

Reports arrive as a batch rather than one call each, because the phone drains
whatever landed while it was closed in a single request when it reconnects. The
desktop raises a notification for every message, for a ringing phone (urgent —
a late one is useless) and for a missed call, and keeps the last 50 in memory
for the bar panel. It is not an archive: the phone already has one.

The same call reaching the desktop down more than one road at once is stored
once. A `call` entry counts as the same call when it shares a state with one
recorded in the last six seconds and either shares its number or brings one it
did not have — which is what folds an iPhone's `+380…` from the hands-free link
together with its `Тарас` from ANCS instead of ringing twice. The first road to
arrive keeps its `via`, which is `"app"`, `"bluetooth"` or `"ancs"`.

`phone.sent` is the phone answering a `send` instruction. The desktop has no
radio, so `POST /api/sms` emits a `phone` event carrying `{ action: "send", id,
to, body }` and holds the HTTP response open until the phone reports back or a
minute passes — which is what lets `omarchy-connect sms` say the message went
out rather than that it was asked for.

`phone.acted` is the same handshake for call control: the desktop emits
`{ action: "call", id, op }` and waits. It is only ever sent when neither
Bluetooth road is open — see below.

The plugin's capabilities are `{ mirror, send, history, answer, bluetooth, ios }`.
`bluetooth` and `ios` describe the desktop's two Bluetooth links rather than
anything the app can supply, and both settle a moment after startup: probing
the buses is asynchronous, so the daemon republishes the status file when each
one answers.

#### Bluetooth

`POST /api/call` prefers the Hands-Free Profile over the app, and the reason is
not preference but capability: Android has refused non-system apps access to
call audio since Android 10, so the app can press the button but cannot carry
the conversation. Bluetooth can, and it needs nothing installed on the phone —
which also makes it the only call feature that works on iOS.

The daemon drives it through PipeWire, which since 1.4 publishes an
oFono-shaped control surface on the session bus:

```
org.pipewire.Telephony                          the bus name, owned by WirePlumber
  /org/pipewire/Telephony                       ObjectManager + org.ofono.Manager
  /org/pipewire/Telephony/ag1                   org.pipewire.Telephony.AudioGateway1
                                                org.pipewire.Telephony.AudioGatewayTransport1
                                                org.ofono.VoiceCallManager
  /org/pipewire/Telephony/ag1/call1             org.ofono.VoiceCall
```

`VoiceCall.Answer` and `VoiceCall.Hangup` do the work; `VoiceCallManager` adds
`HoldAndAnswer` (used when a second call arrives while one is up), `HangupAll`,
`Dial` and `SendTones`; `AudioGatewayTransport1.Activate` forces the audio link
up for handsets that will not open it themselves.

Nothing is parsed out of the D-Bus signals. Any traffic on the name is treated
as *something moved, go look*, and the daemon re-reads `GetManagedObjects` after
a 150 ms settle — which is both shorter than decoding nested variants and
harder to break when the backend's signal set changes.

`bluez5.roles` includes `hfp_hf` by default and the backend is `native`, so a
stock Omarchy needs no configuration. If `GetManagedObjects` has no gateway, no
phone is paired; if the bus name has no owner, PipeWire is older than 1.4.

#### ANCS — the iPhone's own notifications

The hands-free reasoning above has a second half. iOS publishes no messages, no
call log and no notification centre to any app; it publishes all three to a
Bluetooth accessory, through the Apple Notification Center Service. That is a
GATT service **on the phone**, so the desktop is the client:

```
7905F431-B5CE-4E99-A40F-4B1E122D00D0    the service, on the iPhone
  9FBF120D-6301-42D9-8C58-25E699A21DBD  Notification Source   notify
  69D1D8F3-45E1-49A8-9821-9BBDFDAAD9D9  Control Point         write
  22EAC6E9-24D6-4BB5-BE44-B36ACE7C7BFB  Data Source           notify
```

Notification Source pushes eight bytes per event — EventID, EventFlags,
CategoryID, CategoryCount and a little-endian NotificationUID — and nothing
else. Everything readable has to be asked for: a `GetNotificationAttributes`
write to the Control Point naming the UID and the attributes wanted, answered
on the Data Source. Answers longer than the MTU arrive as bare fragments with
no headers of their own, so requests are serialised — one question at a time is
the only way the pieces can be put back together. `PerformNotificationAction`
presses one of the two buttons the notification carries, which for an incoming
call are Answer and Decline.

Categories are the only clue to what a notification *is*: `IncomingCall` and
`MissedCall` become call entries, a known messaging bundle id becomes a message,
and everything else is mirrored as a desktop notification. `EventFlagPreExisting`
marks whatever was already on the lock screen when the desktop subscribed —
those are skipped, so walking into the room does not replay the morning.

Getting the service offered at all is a pairing-time decision on the phone, not
a connection-time one. The desktop advertises the ANCS UUID as a **solicitation**
— an accessory asking to be *given* the service rather than offering it — which
is what makes iOS show the "would like to access your notifications" prompt.
`omarchy-connect ios pair` registers that advertisement through `bluetoothctl`
for a fixed window and takes it down afterwards.

BlueZ is on the **system** bus, and that forces one difference from the
hands-free side. `busctl monitor` needs `org.freedesktop.DBus.Monitoring`, which
is root-only, so writes and reads go through `busctl --system` while incoming
GATT notifications are read from `gdbus monitor`, which subscribes as an
ordinary client. GLib prints a byte array as `[byte 0x01, 0x02, …]` — hex, never
the shorter bytestring spelling, even when the payload is printable — so the
wire format survives the round trip through text intact.

The two links describe the same handset through different windows, and the
daemon folds them together rather than reporting the call twice: hands-free
knows the number, ANCS knows the contact, and a call already in the history
counts as the same call when it shares a state and either a number or a road it
has not been seen on yet. Answering prefers hands-free — ANCS presses the button
but moves no audio.

### agents

Reading a coding agent that is already open on the desktop — what it is doing,
and whether it is stuck waiting for an answer. Off by default; see
**Security model**.

| Method | Params | Returns |
| --- | --- | --- |
| `agents.list` | — | `{ sessions, adapters, write, spawn }` — every session this desktop can see. |
| `agents.open` | `{ id, limit }` | `{ session, blocks, cursor, truncated }`, and starts streaming `agent` events for it. |
| `agents.close` | `{ id }` | `{ ok }` — stops the desktop tailing a transcript nobody is reading. |
| `agents.detail` | `{ id, seq }` | `{ seq, kind, tool, text }` — the full body behind a collapsed one-line chip. |

A session is what the phone lists and opens:

```jsonc
{
  "id": "claude:2fe60a4a-…",       // adapter id + native session id
  "agent": "claude",
  "title": "omarchy-connect",       // basename of cwd
  "cwd": "/home/dan/Projects/omarchy-connect",
  "state": "idle" | "working" | "waiting" | "gone",
  "writable": null,                 // "tmux" | "wtype" once writing ships
  "pane": "%3",                     // tmux pane, when a hook reported one
  "pid": 53316,
  "startedAt": 1756100000000,
  "lastActivity": 1756100420000,
  "preview": "…the last line the agent said…",
  "prompt": "Claude needs your permission to use Bash",   // when waiting
  "via": "hook" | "scan"
}
```

`state` is the field the whole feature hangs on. `waiting` — the agent asked a
question or hit a permission prompt — is the one that earns a badge, because
that is the moment a person on the sofa can actually help.

`via` says how much to trust the rest. **`hook`** means the agent reported in
itself: Claude Code runs a shell hook on every lifecycle event and hands it
`session_id`, `transcript_path` and `cwd` on stdin, and the hook process
inherits the agent's environment, so it also knows the pid and the pane. That
is the only road that can say `waiting`. **`scan`** means the daemon found an
agent binary in `/proc`, read its working directory and matched it to the
newest transcript for that directory — enough to read a session that started
before the hooks were installed, but a heuristic, and labelled as one.

Blocks are agent-neutral, whichever agent produced them:

```jsonc
{ "seq": 12, "at": 1756100000000, "role": "user",      "kind": "text",   "text": "…" }
{ "seq": 13, "at": …, "role": "assistant", "kind": "thinking", "text": "" }
{ "seq": 14, "at": …, "role": "assistant", "kind": "tool",   "tool": "Bash", "summary": "ls -la",
  "ref": "toolu_01…", "expandable": true }
{ "seq": 15, "at": …, "role": "user",      "kind": "result", "ref": "toolu_01…",
  "status": "ok" | "error" | "interrupted", "summary": "…first line…", "lines": 42, "expandable": true }
```

Collapsing tool traffic into one line per call is deliberate: a phone screen
cannot carry a 400-line tool result, and the interesting part of a tool call is
that it happened and whether it worked. The body stays one `agents.detail`
away, fetched only when someone taps. A `result` carries the `ref` of the
`tool` it answers, so the app draws them as one thing.

Two rules the reader never sees the other side of: a `thinking` block's
`signature` is encrypted and is never sent, and traffic from a subagent
(`isSidechain`) is dropped rather than interleaved into the conversation.

Only sessions the phone has opened stream their blocks — the same
reference-counted discipline the stats sampler uses, capped at four transcripts
tailed at once. `state` changes stream for every session, because that is what
drives the badge. A phone that disconnects releases everything it had open.

The three `agent` event frames:

```jsonc
{ "t": "ev", "event": "agent", "data": { "kind": "session", "id": "claude:2fe…", "removed": false, "session": { … } } }
{ "t": "ev", "event": "agent", "data": { "kind": "state",   "id": "claude:2fe…", "state": "waiting",
                                         "prompt": "Allow Bash?", "preview": "…", "lastActivity": 1756100420000 } }
{ "t": "ev", "event": "agent", "data": { "kind": "blocks",  "id": "claude:2fe…", "blocks": [ … ], "cursor": 148 } }
```

A `blocks` frame carries everything one drain of the transcript produced, so a
turn that ran six tools arrives as one frame rather than twelve. `reset: true`
means the transcript was rewritten under the daemon and the reader should
replace what it has rather than append.

`capabilities.agents` is `{ enabled, adapters, read, write, spawn }`. `write` is
`null`: nothing may push bytes into a terminal another process owns, and the
answer — a tmux pane or the compositor typing — is not implemented yet. The app
greys the input out rather than offering a send that would silently do nothing.

### input

Pointer, buttons and keys are injected through Hyprland's own dispatchers over
its control socket — no `uinput` permissions, no helper daemon. A move
round-trips in roughly a tenth of a millisecond, which is what makes a usable
touchpad possible.

| Method | Params | Notes |
| --- | --- | --- |
| `input.state` | — | Cursor position and the logical bounds of all monitors. |
| `input.move` | `{ dx, dy }` | Relative. The daemon caches the pointer position and re-reads it from the compositor when it goes stale, so moving the real mouse does not desync it. |
| `input.moveTo` | `{ x, y }` | Absolute, clamped to the monitor layout. |
| `input.click` | `{ button, count }` | `left`, `right`, `middle`, `back`, `forward`. |
| `input.button` | `{ button, down }` | Press and hold, or release — this is what drag is built from. |
| `input.scroll` | `{ dy, dx }` | See below. Returns the `mode` it used. |
| `input.key` | `{ key, mods }` | A keysym (`Return`, `Escape`, `XF86AudioPlay`) with `SUPER`/`CTRL`/`ALT`/`SHIFT`. |
| `input.text` | `{ text }` | Types literal text through `wtype`, emoji included. |

Hyprland can inject keys and pointer buttons but **not** scroll axes. So
`input.scroll` uses a real wheel only when `ydotool` is installed; otherwise it
falls back to arrow keys and reports `mode: "keys"` so the app can say so rather
than pretending. `capabilities.input.scrollMode` is `wheel`, `keys` or `none`.

Hyprland 0.56 replaced the flat dispatcher names (`workspace 3`) with a Lua API
(`hl.dsp.focus{workspace="3"}`). The daemon asks the compositor which one it
speaks and sends the matching spelling, so both generations work.

## Loopback endpoints

These answer only on `127.0.0.1`, because they are the CLI, a coding agent's
own hook, and the desktop client talking to a daemon they already share a
machine with.

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/pair-code` | — | Mints a fresh six-digit code, valid three minutes. |
| `POST /api/offer` | `{ path }` | Offers a desktop file to connected phones. |
| `POST /api/unpair` | `{ id }` | Forgets a phone **and** hangs up its socket. |
| `POST /api/sms` | `{ to, body }` | Asks the phone to send an SMS; answers when it confirms. |
| `POST /api/call` | `{ op, id?, number? }` | `op` is `answer`, `reject`, `hangup`, `dial`, `tones` or `audio`. Answers `{ ok, via }`. |
| `POST /api/ios` | `{ op, seconds? }` | `op` is `status`, `pair` or `stop`. Answers `{ ok, ios }`. |
| `POST /api/agent/hook` | a hook payload | A coding agent's lifecycle event. Answers `{ ok, id, state }`. |

`POST /api/agent/hook` is the bridge between a coding agent and this daemon:
`omarchy-connect agent hook` reads the agent's JSON on stdin, adds what only
the hook process knows — its parent pid, its `$TMUX_PANE` — and posts it here.
`omarchy-connect agent install-hooks` writes it into `~/.claude/settings.json`
for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and
`SessionEnd`, without disturbing hooks anyone else installed. A hook must never
cost the agent anything, so the post has a one-second timeout, a daemon that is
not running is a silent no-op, and a payload the daemon cannot use answers 200
with an error inside rather than looking like a failed hook.

`unpair` goes through the daemon rather than editing the config file directly
because the running process holds a cached config and possibly an open
connection to that phone; a config edit alone would leave both in place until
the next restart. The CLI falls back to editing the file when no daemon
answers.

## Desktop status file

The daemon publishes its whole state to
`~/.local/state/omarchy-connect/status.json` (mode 0600, `mktemp` + rename)
and rewrites it whenever anything changes — a phone connects or drops, a file
moves, a pairing code is minted or used, the address or firewall verdict
changes. It carries the daemon's identity and address, the paired devices with
their live status and telemetry, recent transfers, counters, the firewall
verdict, whether TLS is on and under which pin, the last mirrored messages and
calls, and the argv needed to invoke the CLI again.

It is the contract the Omarchy shell plugin reads; anything else that wants to
watch this daemon can read it too. `OMARCHY_CONNECT_STATE` moves it aside for
tests or a second daemon. A `running: true` snapshot whose writer was killed
outright stays behind until something probes loopback — `omarchy-connect
status --json` does exactly that and rewrites the file with the truth.

## File transfer

**Phone → desktop.** `POST /api/upload` with `x-oc-token` and `x-oc-filename`.
The body streams straight to `~/Downloads/Omarchy Connect/`, never overwriting
(`report.pdf` becomes `report (2).pdf`). Capped at 512 MB; a partial upload is
deleted. The desktop raises a notification on arrival.

## Security model

- The control channel — every command, every event, the clipboard, notification
  text and file names — is encrypted end to end and the desktop is
  authenticated by a pinned key. See **Encryption** above.
- **File bodies are the exception, unless TLS is on.** `/api/upload` and
  `/api/download` are authenticated by the token, and the offer tokens and file
  names that set them up travel encrypted — but with TLS off the bytes
  themselves do not, and someone already on your LAN could read a file in
  flight. `omarchy-connect tls enable` closes this for any client that can pin
  the certificate; Expo Go and iOS cannot, and stay exposed.
- **Mirrored messages are as sensitive as the messages themselves.** SMS bodies
  and caller names cross the WebSocket, so they are encrypted end to end — but
  they also land in the desktop's notification history and in the status file
  (mode 0600). Granting the permission is a deliberate act in the app, never
  something asked for at startup.
- **Reading a coding agent is reading everything it saw** — source, tool
  output, whatever secrets crossed a `Bash` result. It is the widest exposure
  in the project, wider than the clipboard, so `agents.enabled` defaults to
  **false** and is turned on by `omarchy-connect agent enable`, which says what
  it grants before it grants it. Writing to an agent would be arbitrary code
  execution — the agent runs what it is told — which is why `write` is `null`
  rather than shipped alongside reading.
- Every method call requires a paired token. There is no anonymous access.
- Input injection is reachable by any paired phone: pairing grants control of
  the pointer and keyboard, and should be treated accordingly.
- `system.openUrl` accepts only `http(s)`, so it cannot be used as a generic
  "launch anything" primitive.
- Shutdown, reboot and logout require an explicit `confirm: true`.
- File offers expire after 30 minutes and their tokens are single-purpose.

Treat pairing the way you treat handing someone your unlocked laptop: only pair
devices you own.
