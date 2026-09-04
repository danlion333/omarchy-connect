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

The phone holds the mirror image of that rule, and holds it unconditionally: it
always opens with a key exchange, so every frame it can legitimately be sent is
binary. A text frame arriving on the phone's socket — before the handshake or
long after it — is discarded unread and the socket is closed with `4005`. The
phone never parses a frame it has not decrypted.

## Transport

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/info` | GET | none | Discovery probe. Returns name, version, protocol, active theme, identity key, and whether a phone is already paired. |
| `/api/pair-code` | POST | localhost | Mints a 6-digit pairing code (used by the CLI). `409` when a phone is already paired. |
| `/api/offer` | POST | localhost | `omarchy-connect send <file>` offers a file to phones. |
| `/api/sms` | POST | localhost | Asks the paired phone to send an SMS; answers when it confirms. |
| `/api/call` | POST | localhost | Answers, rejects, hangs up or places a call, over Bluetooth or through the app. |
| `/api/ios` | POST | localhost | Opens or closes the window in which an iPhone will agree to mirror its notifications. |
| `/api/upload` | POST | ticket | Phone → desktop file transfer. Streams to the inbox. |
| `/api/download/<offer>` | GET | ticket | Desktop → phone file transfer for an offered file. |
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
it with `omarchy-connect unpair`.

### One phone at a time

A desktop holds exactly one paired device. While it does, no pairing code
exists to be guessed: `POST /api/pair-code` answers `409` naming the phone in
the way, and a `hello` carrying a `pairCode` is closed with `4003` rather than
displacing the phone already holding a token. `/api/info` publishes
`"paired": true` so a subnet sweep can show a desktop as taken instead of
letting the user discover it by failing to pair.

Freeing the desktop is a deliberate act on the desktop — `omarchy-connect
unpair`, or the panel's unpair button — never a side effect of someone else
scanning a QR. Config files written before this rule keep their newest device
and drop the rest, tokens included, the first time the daemon reads them.

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
  "wake": { … }, "endpoints": [ { "host", "port", "kind" } ], "link": { "via", "kind" },
  "capabilities": { … }, "theme": { … }, "events": [ … ] }

// desktop → phone, then the socket closes
{ "t": "hello.err", "error": "wrong pairing code" }
// … or, when the desktop already holds a phone (close code 4003)
{ "t": "hello.err", "error": "Pixel 8 is already paired — unpair it on the desktop first" }
```

`wake` is what the phone would need in order to wake this desktop later — see
**Wake on LAN** below. It rides every `hello` rather than being asked for,
because the moment it is wanted there is no daemon to ask.

`capabilities` reports what this particular machine can actually do — whether
`wpctl`, `brightnessctl`, `playerctl`, `hyprctl` and the `omarchy-*` helpers are
installed. The app greys out what is missing instead of failing at call time.

`endpoints` is every address this desktop can be dialled on, best first: the
LAN address, then any overlay address (Tailscale, WireGuard, ZeroTier,
NetBird), then the MagicDNS name last of all, as
`kind: "dns"`. A name is offered after the addresses rather than instead of
them because it only resolves while the tailnet's own DNS is switched on,
while the address is ground truth. The phone keeps the list and dials down it;
it does not scan for anything that is not on it. Addresses are IPv4 only,
including Tailscale's — the `fd7a:` ULA is deliberately not advertised, for the
same reason the certificate's SANs are IPv4 only.

With remote access off — which is the default — `endpoints` is the LAN address
and nothing else. The desktop never offers a way in that it would refuse.

`link` is the desktop's verdict on how *this* socket got here: `via` is `"lan"`
or `"remote"`, and `kind` names the overlay when it is remote. It is decided
from the local end of the connection — the address the kernel routed it in on —
and never from the peer's address, because deciding who is a stranger by IP
range is wrong in both directions.

These three fields are additive; the protocol is still 2. A daemon that
predates them sends none of them and a phone that predates them ignores them,
so either half upgrades on its own.

### What the phone is called

`device.name` travels on every `hello`, not just the first, so a phone renamed
in its own settings is renamed on the desktop too. Only a real name counts:
`Android phone`, `iPhone` and the app's other fallbacks are recognised as
generic and never displace a name the desktop already has.

When the phone has no name to give, the desktop asks the network instead — a
reverse lookup on the address the socket came from, which the router answers
with the hostname the phone put on its DHCP lease, so `OnePlus-9-Pro-5G` becomes
`OnePlus 9 Pro 5G`. The lookup runs after the hello is answered and never blocks
it; hostnames the network invented for itself (`android-3f2ac91b`,
`Android_T9UWKJ01`) are refused; and a name found this way is revisited on every
reconnect — so a lease renamed on the router follows, and the phone's own answer
wins the moment it has one.

### Requests

```jsonc
{ "t": "req", "id": 7, "method": "volume.set", "params": { "percent": 35 } }
{ "t": "res", "id": 7, "ok": true, "data": { "output": { "percent": 35, "muted": false } } }
{ "t": "res", "id": 7, "ok": false, "error": "wpctl not installed" }
```

### Events

```jsonc
{ "t": "sub", "events": ["clipboard", "notification", "theme", "file", "phone", "agent", "endpoints"] }
{ "t": "unsub", "events": ["stats"] }
{ "t": "sub.ok", "events": ["clipboard", "notification", "theme", "file", "phone", "agent", "endpoints"] }
{ "t": "ev", "event": "stats", "data": { … } }
```

Both `sub` and `unsub` are additive edits to what one socket wants, not a
replacement for it, and both are answered with `sub.ok` carrying the socket's
whole list. `unsub` with no `events` drops everything. Dropping a subscription
the socket never had is not an error and changes nothing.

Subscriptions are reference-counted: the 1 Hz stats sampler only runs while at
least one phone is subscribed. `stats` is the one event the app does not ask
for on connect — it is subscribed while the dashboard is on screen and the app
is in the foreground, and unsubscribed as soon as either stops being true, so a
phone in a pocket costs the desktop nothing. Everything else on the list is
news the phone wants precisely when nobody is looking at it, and stays
subscribed for the life of the socket. A `system.stats` request still answers
whether or not the event is subscribed, which is how a returning screen fills
itself without waiting for the next tick.

| Event | Fires when |
| --- | --- |
| `stats` | Every second — CPU, memory, disk, battery, network, latency. |
| `clipboard` | The desktop clipboard changes: text (≤256 KB) as `{ kind: "text", text }`, or a copied picture as `{ kind: "binary", mime, text: null, token, name, size }` — the token is a standing file offer, fetched over `/api/download/<token>` like any other. |
| `notification` | Omarchy writes a new notification to its history. |
| `theme` | The active Omarchy theme changes. |
| `file` | A file arrived from a phone, or the desktop offered one. |
| `phone` | A mirrored SMS or call arrived (`action: "received"`), or the desktop is asking the phone to send one (`action: "send"`) or to say where it is (`action: "locate"`). |
| `agent` | A coding agent appeared, changed state, or said something new. |
| `endpoints` | The set of addresses this desktop can be dialled on changed — a tunnel came up or went down, the lease moved, or remote access was switched. Carries the whole list, not a delta. |

A binary clipboard — a screenshot, above all — does not travel on the event
itself. The bytes are spooled to `~/.cache/omarchy-connect/clipboard` and
handed to the same offer table `omarchy-connect send` uses, so what the phone
receives is a token and the picture comes down `/api/download/<token>` behind
a one-use ticket, exactly like a file the desktop offered on purpose. Nothing
new is opened for it, and the picture arrives as something the phone can
already preview, save to the gallery or hand to a coding agent through
`agents.attach`. The ceiling is 32 MB and the spool is swept — an hour of the
offer's own lifetime, twenty files — because a copied screenshot is scaffolding
for the next question, not a file anybody meant to keep. Phone → desktop stays
text: `clipboard.set` takes `{ text }` and nothing else.

The `phone` channel is never delivered to a socket the desktop classed as
`remote`: a call the desktop is asking a handset to answer has no business
travelling to a handset that is nowhere near it.

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
| `clipboard.get` / `clipboard.set` | — / `{ text }` — `get` answers with the same shape as the `clipboard` event, so a copied picture comes back as an offer (`token: null` when the desktop is holding one it will not carry: over 32 MB, or unreadable). `set` is text only. |
| `notifications.list` | `{ limit }` — the Omarchy notification history |
| `notifications.send` | `{ summary, body, urgency }` — phone → desktop notification |
| `share.text` | `{ text, action: "clipboard" \| "file" }` |
| `share.inbox` | `{ limit }` — files received from phones |
| `share.offers` | — files the desktop is currently offering |
| `share.ticket` | `{ use: "upload" \| "download" }` → `{ ticket, use, expiresAt, ttlMs }` — a one-use pass for one HTTP file transfer |
| `theme.list` / `theme.current` / `theme.set` | — / — / `{ name }` |
| `hypr.workspaces` / `hypr.goto` | — / `{ id }` |
| `hypr.windows` / `hypr.focus` / `hypr.close` | — / `{ address }` |

### dictation

| Method | Params | Returns |
| --- | --- | --- |
| `dictation.transcribe` | `{ path }` | `{ ok, text, ms }` — the words in a recording the phone uploaded. |

The audio arrives the way a screenshot does — `/api/upload` with `dest: agent`,
into the drop directory — so this method takes a path rather than bytes, and
checks it against that directory rather than trusting it. `ffmpeg` resamples to
the 16 kHz mono whisper reads, clamped to the length the handshake published,
and `voxtype` reads it. Both copies are deleted before the answer goes back,
on every road out: a recording is a way of typing, not a file anybody meant to
keep. Gated on the same switch as agent control, because the bytes cannot reach
the desktop any other way. The capability is `{ available, maxSeconds }` and is
false on a desktop without `voxtype` or `ffmpeg`.

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
| `phone.located` | `{ id, ok, error, found }` | `{ ok }` |

An event is either

```jsonc
{ "kind": "sms",  "at": 1724600000000, "from": "+1555…", "name": "Mum", "body": "dinner at eight" }
{ "kind": "call", "at": 1724600000000, "from": "+1555…", "name": null,
  "state": "dialing" | "ringing" | "active" | "ended", "missed": true,
  "direction": "incoming" | "outgoing" | "missed", "seconds": 154,
  "call": "a token for this conversation", "startedAt": 1724600012000 }
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

`at` is the phone's own clock, and the desktop reads it: a report stamped more
than two minutes ago is written into the history and the counters and
published to the panel, but raises no notification, no ringtone and no
Bluetooth page. Otherwise a handset coming back onto the network after an
afternoon away announces every call and message of that afternoon at once, all
of them already dealt with on the phone. The age of each report decides on its
own, not the fact that it travelled in a batch — the same batch usually
carries the message that landed a second before the phone dialled, and that
one still interrupts. A report with no `at` is treated as happening now, which
is what the roads with no clock of their own — hands-free, ANCS — send.

`call` is the phone's own token for one conversation, and `startedAt` is the
handset's clock reading for the moment somebody picked up — which on a call the
phone placed is minutes after the desktop was told the line went off-hook, so
it displaces the desktop's guess whenever it arrives. Both are optional: the
roads with no app on the other end (hands-free, ANCS) send neither.

One conversation is one line, however many reports it takes and however many
roads they come down. A report is folded into a line already there when it
carries the same `call` token; or when it is the call this desktop is already
holding, moving on from ringing to answered to over; or — for the roads that
carry no token — when it shares a state with a line recorded in the last six
seconds and either shares its number or brings one it did not have, which is
what folds an iPhone's `+380…` from the hands-free link together with its
`Тарас` from ANCS instead of ringing twice. The first road to arrive keeps its
`via`, which is `"app"`, `"bluetooth"` or `"ancs"`.

A report that names nobody — no `from`, no `name` — is not read as a new call
even when it carries a token the desktop has never seen, because most `ended`
reports are exactly that: Android broadcasts the end of a call without the
number in it. An anonymous `ended` closes the conversation the desktop is
holding, or failing that the newest line in the history that was never seen to
end. One that belongs to neither, and carries no `seconds` and no `missed`
either, takes the call card and the clock down and is *not* written to the
history: a row saying `unknown` with nothing but a timestamp under it is not a
record of anything, and counting it would count a second call for a
conversation that was already counted.

`phone.sent` is the phone answering a `send` instruction. The desktop has no
radio, so `POST /api/sms` emits a `phone` event carrying `{ action: "send", id,
to, body }` and holds the HTTP response open until the phone reports back or a
minute passes — which is what lets `omarchy-connect sms` say the message went
out rather than that it was asked for.

`phone.acted` is the same handshake for call control: the desktop emits
`{ action: "call", id, op }` and waits. It is only ever sent when neither
Bluetooth road is open — see below.

#### Find my phone

`POST /api/locate` emits `{ action: "locate", id, op: "start" | "stop",
seconds }` and holds the response open until `phone.located` comes back, so
`omarchy-connect locate` reports a phone that *is* ringing rather than one that
was asked to. The window is 5–300 seconds and defaults to 60.

The app answers by playing the system alarm tone on the **alarm stream**,
looping, at that stream's maximum, with the volume restored afterwards. That
stream is chosen because silent mode and Do Not Disturb both mute notifications
and neither mutes alarms — a search that stayed quiet on a silenced phone would
only ever find the phones nobody loses. It buzzes alongside, and puts up an
ongoing high-importance card whose every surface stops it.

The handset owns the clock. It stops after the window it was given whatever the
desktop does next, so a daemon that dies mid-search cannot leave a phone
shouting in an empty house; the desktop expires its own copy of that window at
the same moment.

`phone.located` travels twice for one search. With an `id` it is the answer to
an instruction — `ok: false` for a build that cannot ring itself, which is
Expo Go and every iPhone. With `found: true` and no `id` it is a person: the
button on the ringing phone was pressed, which is the answer to the question
the desktop asked, and the desktop says so and stops claiming the phone rings.

There is no Bluetooth road under this one, and that is deliberate: hands-free
carries audio to *this* machine, and a phone that is lost has to be loud where
it is. The app is the only road, so a desktop with no phone on the socket
refuses rather than pretending.

The plugin's capabilities are `{ mirror, send, history, answer, locate, bluetooth, ios }`.
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

None of that surface exists until the profile is connected, which is BlueZ's
business rather than PipeWire's: `Device1.ConnectProfile` with the phone's
`0000111f-…` UUID raises the one link this needs and leaves the rest of the
device — A2DP, AVRCP — where the user put it.

*Which* device is decided before any of that. `Device1.UUIDs` is a cache of the
last SDP read and is empty of classic profiles for a handset bonded over low
energy alone, so it is read as evidence rather than used as a filter — a bonded
device that looks like a phone by `Icon` or by the major field of its class of
device is a candidate whether or not `111f` is in the cache, and only
`ConnectProfile` can tell a cold cache from a handset that genuinely cannot do
this. Among the candidates, a pinned address wins, then the handset whose name
matches the phone paired over the LAN, then the old heuristic — one unambiguous
phone-shaped device. The name is the join because it is the only identifier
both halves publish: Android answers `BluetoothAdapter.getAddress()` with
`02:00:00:00:00:00` for ordinary apps, so the phone cannot report where it
lives. `link.matched` in the summary says which of the three answers was used.

A raise in flight owns the link for as long as it is in flight. The gateway
appearing is what tells `attempt` it succeeded, and the refresh carrying that
news reaches the stand-down check one statement before the owner is recorded —
so without that rule the desktop reads its own half-finished page as a link
BlueZ reconnected on its own, and puts it back down three seconds later.

`ConnectProfile` failing with `br-connection-key-missing` means the bond exists
without a classic link key — the state an LE-only pairing leaves behind, and
one nothing on the desktop can repair, because the key has to be minted by a
pairing rather than recovered. `handsfree.autoConnect` in the
config decides when that happens. Under `ring`, the default, the link is raised
when a call is reported and dropped fifteen seconds after the last one clears,
and a link found idle that this daemon did not raise — BlueZ reconnects a
bonded handset on its own — is dropped after three seconds. That last rule
gives up after three drops inside a minute, so a handset determined to hold the
profile open is not argued with forever — while one that reconnects an hour
later is treated as a phone walking back into the room rather than the same
argument. Under `presence` the link follows the app onto the
network instead; under `off` nothing is raised or dropped unasked. A link
raised by hand through `op: "connect"` is never dropped by policy.

##### Making the bond

All of the above assumes a bond exists. `op: "bond"` is how one gets made
without leaving for a Bluetooth settings screen, and it opens both directions
at once because either end can be the one that moves:

```
Adapter1.Pairable      = true    the desktop will accept a bond
Adapter1.Discoverable  = true    the desktop can be found and picked
bluetoothctl --agent NoInputNoOutput
                                 something to answer BlueZ's pairing questions,
                                 and — in the same process — the scan
Device1.Pair                     the desktop asking, when it sees the phone first
Device1.Trusted        = true    so the handset may reconnect unattended
```

Both adapter timeouts are handed to BlueZ (`DiscoverableTimeout`,
`PairableTimeout`) rather than kept on a timer in the daemon: a process killed
outright must not leave the machine offering itself to the street.

The agent is `bluetoothctl` rather than a D-Bus object of this daemon's own,
which is the same trade `ancs.js` makes — one dependency, and the agent lives
exactly as long as the window does. `NoInputNoOutput` is the honest capability
for a daemon with no dialog to show, and it is what makes both ends settle on
Just Works: the prompt appears on the handset, and nothing has to be read back
here — no code on either side, which is the pairing this window is built for.

Built for, not guaranteed. BlueZ routes every pairing question to the default
agent whatever capability it declared, and a handset that failed to learn the
desktop speaks Secure Simple Pairing falls back to *legacy* PIN pairing — seen
in the wild on a radio that hung and reset itself between the feature exchange
and the pairing, which left the phone asking its user for a code "usually 0000
or 1234". So the agent reads bluetoothctl's prompts and answers them instead
of leaving them hanging: a PIN request gets `0000` and the code is surfaced as
`link.bonding.pin` so every screen can say "type 0000 on the phone", and the
yes/no family — confirm this passkey, accept this pairing, authorize this
service — is answered yes only for the handset the window was opened for.

Only for that one, because a discoverable window is thirty seconds of an
invitation the whole room can read, and an agent that says yes to every
question that arrives during one bonds with whoever asks first. bluetoothctl's
prompts do not say whose question it is — "Confirm passkey %06u (yes/no):",
"Accept pairing (yes/no):", no address anywhere — so the subject is taken from
BlueZ's own tree at the moment of the question: the devices this desktop is
`Connected` to and has not `Paired` with are the ones mid-pairing, and the
answer is yes only when every one of them is the expected handset, by the same
name match used everywhere else or by the address this desktop just paged
itself. Anything else — nothing mid-pairing, or a stranger in there alongside
the phone — is a no and a line in the log; the window pages again on its own,
so a wrong no costs a retry where a wrong yes costs a bond. With no LAN
pairing there is no name to expect, and there the window is still the consent,
which is the same reason that state waits to be chosen rather than choosing.

The scan runs inside that same process for a reason worth writing down:
`SetDiscoveryFilter` is remembered per D-Bus client and forgotten when the
client goes, and every `busctl` invocation is a client that lives for
milliseconds — so a filter set that way is gone before the scan it shapes ever
starts. The filter is `Transport=bredr`, because hands-free is a classic
profile and a bond made over low energy is the one kind that cannot carry it.

The desktop only ever *asks* a handset whose name matches the phone paired over
the LAN, and only over a `public` address — a `random` one is the low-energy
half of the same phone under a rotating identifier. With no LAN pairing to join
against, it waits to be chosen rather than choosing: a discoverable window is
one anybody in range can walk through, and a desktop that pairs itself to a
stranger's handset because it was the only one scanning is worse than one that
waits.

`Trusted` is set on success and is a separate fact from the bond. The bond says
the two ends know each other; trust says this desktop will let that handset
connect a profile without asking anybody first — and without it, a phone
reconnecting on its own after a call raises a prompt nobody is standing at the
desktop to answer. Every Bluetooth settings panel sets it at pairing time.

`link.bonding` in the summary carries the window while it is open — `until`,
a `stage` of `opening`, `looking`, `pairing` or `connecting`, and a `pin` that
is null until the legacy fallback engages — so the panel and `call status` can
say what is being waited for rather than freezing for a minute. `op: "bond"`
with `value: "stop"` shuts it early.

On success the link is raised once, to prove the bond carries the profile
while both ends are warm, and then put back down on purpose (`parked: true` in
the answer): the workflow the bond exists for is paired, disconnected, and
raised for the length of a call — a ring brings the link up by itself, and the
call ending takes it back down. A call that began inside the window is the one
thing that keeps the link up.

`ringtone` in the config is what a ringing phone sounds like on the desktop:
the freedesktop sound theme's `phone-incoming-call` by default, played on a
loop through `paplay`, `pw-play` or `canberra-gtk-play` until the call is
answered, declined or rings out. It stops early if the handset opens the audio
link while still ringing, because that is a phone sending its own ringing tone
and one ring is enough.

`otp` in the config is what happens to a one-time code inside a mirrored
message: `enabled` puts a **Copy** button on the card of any SMS that turns out
to carry one, and `autoCopy` skips the button and writes the code to the
clipboard as it arrives. The second is off by default — it overwrites the
clipboard unasked, on the strength of a guess about what the message meant.

Whether a message carries a code is decided by the words around the number
rather than by the number, using otphelper's phrase, ignore and cleanup lists;
digits are matched as `\p{Nd}` and normalised to ASCII, so a message written in
Persian digits yields the same code as one written in Arabic numerals. The code
is written through the clipboard plugin's own `claim`, which marks it as
already seen — otherwise the clipboard channel would publish it straight back
to the phone that sent it.

The message is flattened to single spaces before any of that runs. The matcher
steps over the prose between the trigger word and the code with `\s*` in front
of a run that can itself match whitespace, and two ways of consuming the same
blank is catastrophic backtracking: a message of nothing but spaces stalled the
daemon — call control and the socket with it — for five seconds, and the body
of an SMS is written by anyone who knows the number. Flattening changes no
answer, because a code is never told apart from a non-code by how many blanks
precede it.

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
whether it is stuck waiting for an answer, and answering it. Off by default;
see **Security model**, because writing to an agent is a shell.

| Method | Params | Returns |
| --- | --- | --- |
| `agents.list` | — | `{ sessions, adapters, write, keys, spawn }` — every session this desktop can see. |
| `agents.open` | `{ id, limit, since, epoch }` | `{ session, blocks, cursor, epoch, truncated, resumed }`, and starts streaming `agent` events for it. |
| `agents.close` | `{ id }` | `{ ok }` — stops the desktop tailing a transcript nobody is reading. |

`agents.open` is also how a phone comes back. The desktop stops tailing every
open session when the event bus loses its last subscriber, so a dropped socket
ends the stream; the app re-opens each session it has on screen as soon as it
has said `hello` again. Passing `since` — the `cursor` from the last open — with
the `epoch` that came back beside it makes that a resume: the reply carries
`resumed: true` and only the blocks numbered after the cursor, which the app
appends. A cursor the desktop cannot honour is answered with the whole window
and `resumed: false`, and the app replaces what it has.

`epoch` is what makes the cursor checkable. Block numbers restart at one
whenever a session's numbering does, and they are dealt out deterministically
from the same window of the same file — so a daemon that restarted while the
phone was away would hand out the same numbers again for what need not be the
same blocks. The epoch is new for every run of the daemon and new again every
time a session's counter goes back to zero, so a cursor from before either is
recognised as one and refused.

A session a phone stopped reading because its socket died is not the same as
one it closed: the desktop stops tailing it but keeps what it had, numbering
included, for a few minutes, which is what a resume across a reconnect is
resuming from. `agents.close` throws it away immediately, as it always did.

| `agents.detail` | `{ id, seq, agentId }` | `{ seq, kind, tool, text }` — the full body behind a collapsed one-line chip. With `agentId`, the same out of the worker's window that `agents.worker` last handed over. |
| `agents.worker` | `{ id, agentId, limit }` | `{ worker, blocks, truncated }` — one worker of a session, and the conversation it had. |
| `agents.send` | `{ id, text, submit }` | `{ ok, via, pane \| window, submitted }` — types a message and, unless `submit` is false, presses Return. `submitted` is what the desktop observed, not what it was asked for. |
| `agents.relay` | `{ id, agentId, text }` | `{ ok, queued, agentId, worker, via, submitted }` — a message for one of the session's workers, typed into the *session's* composer for it to pass on. `queued`, never delivered. |
| `agents.key` | `{ id, key }` | `{ ok, via, key }` — one named key from the whitelist `capabilities.agents.keys`. |
| `agents.answer` | `{ id, seq, question, choices }` | `{ ok, labels, via, keys }` — picks options off a multiple-choice question by position. |
| `agents.attach` | `{ id, paths, text, submit }` | `{ ok, paths, via, submitted }` — hands the agent one or more pictures the phone uploaded, with a message. |
| `agents.screen` | `{ id, lines }` | `{ id, pane, screen }` — the pane as the terminal draws it. Needs a multiplexer: tmux or herdr. |
| `agents.limits` | — | `{ limits }` — how much of the plan is left, or `null`. |
| `agents.skills` | `{ id \| cwd }` | `{ cwd, skills, commands, builtins }` — everything the agent answers to by name. |
| `agents.command` | `{ id, name, args, submit }` | `{ ok, command, via }` — runs one, with `name` checked against that list. |
| `agents.history` | `{ cwd, limit }` | `{ sessions, spawn }` — the conversations on disk, running or not. |
| `agents.tasks` | `{ id }` | `{ tasks, total, done, active }` — the list this session is working through. |
| `agents.jobs` | `{ all }` | `{ jobs, open }` — background agents, and which of them are also live sessions. |
| `agents.job` | `{ id }` | `{ job }` — one of them, with the last few things it said about itself. |
| `agents.spawn` | `{ cwd, resume, prompt, background, name }` | `{ ok, cwd, resumed, via }` — starts one. Behind its own switch. |

A session is what the phone lists and opens:

```jsonc
{
  "id": "claude:2fe60a4a-…",       // adapter id + native session id
  "agent": "claude",
  "title": "Bluetooth pairing hangs",  // the CLI's own name for the conversation
  "project": "omarchy-connect",     // basename of cwd, since the title no longer is
  "cwd": "/home/dan/Projects/omarchy-connect",
  "state": "idle" | "working" | "waiting" | "gone",
  "writable": "tmux",               // "tmux" | "herdr" | "wtype" | null — how it can be answered
  "pane": "%3",                     // the multiplexer's pane — "%3" for tmux, "w1:p1" for herdr
  "pid": 53316,
  "startedAt": 1756100000000,
  "lastActivity": 1756100420000,
  "preview": "…the last line the agent said…",
  "prompt": "Claude needs your permission to use Bash",   // when waiting
  "via": "hook" | "scan",
  "vitals": { … },                  // the desktop's own status line, below
  "job": { … } | null,              // the background job behind it, when it is one
  "tasks": { "total": 7, "done": 3, "active": "Adding the endpoint", "next": null } | null,
  "subagents": 2,                   // workers it has out — the count on its own
  "workers": [ … ]                  // …and who they are, below
}
```

#### The workers a session fanned out

A session that spawned agents of its own used to be a number: `subagents`,
counted up on `SubagentStart` and back down on `SubagentStop`. That number is
the whole screen for a session working through a queue, because all the work is
in the worker and the session that spawned it is standing still — and it says
nothing about what any of them is doing.

Claude Code writes each worker beside the session's own transcript, in
`~/.claude/projects/<slug>/<session-id>/subagents/`: `agent-<id>.jsonl` is the
conversation in the same format as any other, and `agent-<id>.meta.json` says
what the worker is. So the daemon reads them the way it reads everything else,
and a worker's transcript parses into exactly the same blocks.

```jsonc
{
  "id": "a039c95c91ad3ab24",
  "type": "Explore",                 // the kind of agent it is
  "description": "Protocol + docs for agents",   // what the caller sent it to do
  "ref": "toolu_011dsbL6…",          // the `Agent` call that started it
  "depth": 1,
  "startedAt": 1756100000000,
  "updatedAt": 1756100420000,
  "running": true,
  "preview": "…the last line it said…"
}
```

`ref` is the link between the two halves of the screen: it is the `tool_use` id
of the `Agent` call in the parent's own transcript, so the chip already drawn in
the parent's chat and the row under the session are the same worker, and tapping
either opens it.

A worker is **never a session**. It has no terminal, no `--resume`, and no pid,
so it never takes a row of its own in `agents.list`, is never opened or tailed,
and `agents.worker` answers with a window and no cursor — a phone that wants a
newer one asks again. A hook payload that names a worker's transcript is folded
onto the session it belongs to rather than minting a row for it.

#### Answering one

All three writing roads end at a pty and a worker has none, so `agents.send`
cannot reach one and no amount of plumbing would make it. What does hold the
worker is the session that spawned it: it has the worker in its own process, it
knows its `agentId`, and it has a tool that continues it. So `agents.relay` is
addressed to the worker and written to the parent — the message goes into the
parent's composer with the worker named in front of it, asking the parent to
continue that agent rather than start another.

```jsonc
{ "id": "claude:1111…", "agentId": "a039c95c91ad3ab24", "text": "look at the router again" }
```

It is a method of its own rather than a flag on `agents.send` because the two
promise different things. `agents.send` means *the agent was asked this*;
`agents.relay` means *the parent was asked to ask this*, which is why the answer
says `queued` and never `delivered`. The worker is looked up first, so a phone
naming a worker the session never had hears that rather than hearing about
tmux; a session whose `writable` is `null` is refused outright, because there is
no queue behind this and a message accepted into nowhere reads on the phone
exactly like one that arrived. Nothing here is a new permission: the gate is the
same switch that granted reading and `agents.send`, and the phone could always
have typed the same paragraph into the parent by hand.

`capabilities.agents.relay` says the desktop understands the call, the way
`workers` says it can read them.

`running` is the clock. There is no completion marker anywhere in a worker's
transcript — the CLI writes the meta file once at spawn and the last line of a
finished worker is an ordinary assistant message — so a worker that has not
written for ninety seconds is finished. A `SubagentStop` this daemon was awake
for says it exactly, and outranks the clock; the clock is what survives a
restart. Either way a finished worker **stays on the list** with the last thing
it said, because what it went and found out is worth more once it is done.

`subagents` stays for a desktop whose CLI keeps no such directory: `workers` is
empty there, and the number is the whole answer, exactly as it was.

#### The status line

`vitals` is what Claude Code draws under its own prompt, read off the
transcript rather than asked of the session — which is the whole reason it can
exist at all: the phone shows a desktop session's status line with no
cooperation from that session.

```jsonc
{
  "model": "claude-opus-5",
  "effort": "high",
  "mode": "normal",                 // the permission mode; "plan", "bypassPermissions", …
  "branch": "master",
  "version": "2.1.241",
  "title": "Bluetooth pairing hangs",
  "cwd": "/home/dan/Projects/omarchy-connect",
  "turnAt": 1756100420000,
  "context": { "tokens": 149388, "window": 1000000, "percent": 15 }
}
```

`context` counts everything on the last `usage` record that occupies the
window — input, output, and both halves of the cache. A meter built on
`input_tokens` alone reads *two* where the truth is two hundred thousand,
because almost the whole conversation arrives from the cache on every turn.
The window is 200k unless the configured model asks for the long one
(`opus[1m]` in `settings.json`) or the session is demonstrably past 200k
already; being wrong in the safe direction matters, since a meter reading 90%
when the truth is 18% is somebody compacting a conversation that did not need
it.

`title` waits for the conversation to have a turn in it. Claude Code seeds a
brand-new session with the last title the project had and generates its own
only once there is something to name, so handing that on unguarded would put
yesterday's sentence over an empty session.

#### What it is working through

`tasks` is read from `~/.claude/tasks/<session id>/`, one small JSON file per
task, which is where Claude Code keeps the list it is working through. It
matters because an agent at work produces a great deal of traffic and very
little news: the transcript says it ran `grep`, then read a file, then ran
`grep` again — all true, and no use at all to somebody holding a phone who
wants to know whether the thing they asked for is nearly done.

`active` is the task's `activeForm`, the present-continuous the CLI shows in
its own spinner; `next` is the first unblocked pending one, for the moment
between two tasks — a strip that says "nothing in progress" then reads as an
agent that has stopped, which is the one thing it has not done. That is the field this is carried for: a row that says
"Adding the endpoint" is one you can act on, and `Bash grep -rn router src` is
not. The summary rides on every session frame; `agents.tasks` returns the list
itself, because the summary is what tells six rows apart and the list is what
you read once you have picked one.

#### Limits

`agents.limits` — and `capabilities.agents.limits`, and the `limits` on
`agents.list` — come from the account service itself: a `GET` to
`api.anthropic.com/api/oauth/usage`, carrying the OAuth token Claude Code
already keeps in `~/.claude/.credentials.json` and the `oauth-2025-04-20` beta
header. That endpoint answers every window at once — the five-hour session, the
seven-day account window, and the scoped rows that are the only place a
per-model allowance appears — and it answers as of now. The token is read at
the moment of the request, never held and never sent to a phone; only the
percentages travel.

`agents.limits` probes on every call, because asking it is a person asking
about now. The daemon otherwise probes every five minutes, and only while a
phone is subscribed.

Two older readings stay underneath as fallbacks, and a row says which it came
from by carrying an age. `cachedUsageUtilization` in `~/.claude.json` is what
the CLI parks for its own status line, rewritten when it feels like it; the
status-line bridge overlays the two unscoped windows between probes for free.
Whichever reading is newest wins.

```jsonc
{
  "fetchedAt": 1756100000000,
  "stale": false,                   // any row older than six hours: history, not status
  "probeStatus": "offline",         // absent on the normal path; why nothing is newer
  "limits": [
    { "kind": "weekly_all", "label": "week", "percent": 73, "asOf": 1756100000000,
      "resetsAt": 1756400000000, "severity": "normal", "active": true, "stale": false }
  ],
  "spend": null                     // extra usage, when the account has it switched on
}
```

A change is pushed as an `agent` event (`kind: "limits"`) rather than polled,
and only when a percentage actually moves.

#### Skills and commands

`agents.skills` reads the same directories the CLI reads: `~/.claude/skills`
and `<cwd>/.claude/skills` for skills, `commands/` beside each for slash
commands, plus a curated list of the CLI's own built-ins. A project entry
shadows a user one of the same name, exactly as the CLI resolves it.

```jsonc
{ "kind": "skill", "name": "adb-phone", "description": "Drive a real Android phone…",
  "scope": "project", "args": "[focus]" }
```

`agents.command` exists beside `agents.send`, which could carry the same
string, for one reason: the name is checked against the list the desktop just
published before it becomes a line of text in front of an agent. What the phone
offers and what the desktop will type are then the same set, and a stale app
cannot invent a command by asking for one. Arguments are not checked and cannot
be — an argument to a skill is prose, and it is the same prose `agents.send`
already carries.

A row with an `args` hint is one the phone puts in the composer rather than
running: the interesting half is the part the list cannot know.

#### History, background agents, and starting one

`agents.history` lists the transcripts on disk, running or not — the set
`--resume` picks from. A project directory's name is a slug with every
separator flattened to a dash and cannot be turned back into a path, so the
working directory is read off the file itself.

```jsonc
{ "id": "claude:9be93f58-…", "sessionId": "9be93f58-…",
  "cwd": "/home/dan/Projects/omarchy-connect", "title": "Bluetooth pairing hangs",
  "model": "claude-fable-5", "branch": "master",
  "context": { "tokens": 154975, "window": 1000000, "percent": 15 },
  "at": 1756100420000, "size": 9731643,
  "live": false, "liveId": null, "background": false }
```

`agents.jobs` reads `~/.claude/jobs/<short>/state.json`, which is where the CLI
keeps its bookkeeping for a `--bg` session. A background agent has no terminal,
so nothing on the desktop is drawing it — no pane, no window, no bar — and
`detail` is the sentence it wrote about what it is doing, which is the only
running commentary such a session has anywhere.

`agents.spawn` is behind **its own switch**, `agents.spawn` in the config,
turned on with `omarchy-connect agent spawn on`. Reading an agent and answering
the one already open are things somebody at the desktop started; this starts a
process that was not there before, which is a different sentence to say yes to.
It goes down one of two roads:

- **A pane nobody is looking at** — `tmux new-session -d`, or a herdr workspace
  created on a server that is already up. Exactly the shape the writer wants:
  answerable from the phone immediately, and there to attach to when you sit
  down. tmux is asked first only because it starts a server on demand where
  herdr's is a thing the person at the desktop keeps running; the herdr road
  hands the prompt over as an argument array rather than as a command line,
  because a prompt from a phone is arbitrary text.
- **`claude --bg`** — detached outright. No terminal, no pane, nothing that can
  ever be typed into. What it gets instead is a job the CLI tracks, which is
  what makes an agent worth starting from a phone you are about to put in your
  pocket.

`cwd` is resolved and checked; `resume` is checked against the transcripts on
disk rather than against a pattern, because "it looks like a uuid" is a weaker
promise than "it is one of the files we listed". There is deliberately no
allow-list of directories — a phone that may type into an agent may already
`cd` anywhere, and pretending otherwise would be a fence with no field behind
it.

`state` is the field the whole feature hangs on. `waiting` — the agent asked a
question or hit a permission prompt — is the one that earns a badge, because
that is the moment a person on the sofa can actually help.

Both roads into `waiting` run through a hook, for the same reason: what an
agent is blocked on is not on disk while it is blocking. A permission prompt is
drawn on the terminal and written down nowhere at all. A multiple-choice
question is a tool call, and a tool call does land in the transcript — but
Claude Code flushes the assistant turn only once the tool inside it has
returned, so the question appears in the file at the moment it stops being one.
A session discovered by scanning `/proc`, with no hooks installed, can see that
an agent has gone quiet and never why. So the question a phone answers arrives
from a `PreToolUse` hook scoped to `AskUserQuestion`, and the transcript copy
that lands afterwards is dropped as a duplicate, matched on `tool_use_id`.
Clearing differs: `PostToolUse` says a question was answered, while a permission
prompt answered at the keyboard fires no event this daemon subscribes to and is
cleared by the transcript moving again.

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

`text` and `thinking` blocks are never shortened: what the agent said is the
thing the phone was opened for, and an answer ending in `… truncated` is the
recommendation missing. The bodies behind a chip are the ones with a cap —
`agents.detail` returns at most 32 KiB and says `… truncated` when a log ran
past it.

One tool call is the exception, and arrives whole:

```jsonc
{ "seq": 16, "at": …, "role": "assistant", "kind": "question", "tool": "AskUserQuestion",
  "ref": "toolu_01…", "summary": "Which database?",
  "questions": [ { "header": "Storage", "question": "Which database?", "multiSelect": false,
                   "options": [ { "label": "Postgres", "description": "already in the compose file" },
                                { "label": "SQLite",   "description": "no server to run" } ] } ] }
{ "seq": 17, "at": …, "role": "user", "kind": "result", "ref": "toolu_01…", "status": "ok",
  "answers": { "Which database?": "SQLite" } }
```

The options *are* the reason it is worth putting on a phone: an agent blocked
on a question the reader can see but not answer is a blocked agent. And the
order matters twice over — it is the order the terminal draws the list in, and
an option's position is the keystroke that picks it. That is why `agents.answer`
takes a block and an index rather than a digit: the desktop checks the option
against the question it actually asked, so a stale screen gets a refusal instead
of answering some later prompt by accident. A single-choice list is answered by
the digit alone, which picks and moves on in one press. A multi-select only
toggles: the digits tick the boxes and nothing has been said yet, so the answer
walks the tabs along with `Right` — onto the next question, or onto the submit
tab when this was the last one, where Return sends. Return pressed on the
checkbox screen toggles whatever row is highlighted instead.

Two rules the reader never sees the other side of: a `thinking` block's
`signature` is encrypted and is never sent, and traffic from a subagent
(`isSidechain`) is dropped rather than interleaved into the conversation.

Only sessions the phone has opened stream their blocks — the same
reference-counted discipline the stats sampler uses, capped at four transcripts
tailed at once. `state` changes stream for every session, because that is what
drives the badge. A phone that disconnects releases everything it had open.

The `agent` event frames:

```jsonc
{ "t": "ev", "event": "agent", "data": { "kind": "session", "id": "claude:2fe…", "removed": false, "session": { … } } }
{ "t": "ev", "event": "agent", "data": { "kind": "state",   "id": "claude:2fe…", "state": "waiting",
                                         "prompt": "Allow Bash?", "preview": "…", "lastActivity": 1756100420000 } }
{ "t": "ev", "event": "agent", "data": { "kind": "blocks",  "id": "claude:2fe…", "blocks": [ … ], "cursor": 148 } }
{ "t": "ev", "event": "agent", "data": { "kind": "draft",   "id": "claude:2fe…", "append": " ще кілька слів" } }
{ "t": "ev", "event": "agent", "data": { "kind": "control", "enabled": true, "adapters": ["claude"], "write": "tmux" } }
{ "t": "ev", "event": "agent", "data": { "kind": "limits",  "limits": { "limits": [ … ], "stale": false } } }
```

A `blocks` frame carries everything one drain of the transcript produced, so a
turn that ran six tools arrives as one frame rather than twelve. `reset: true`
means the frame is the list rather than an addition to it, and the reader should
replace what it has rather than append — either the transcript was rewritten
under the daemon, or a block already sent has moved. A question carried ahead of
the transcript by a hook moves exactly once: down behind the words of the turn
it was held back with, when that turn lands. It keeps its `seq` through the
move, so an `agents.answer` already in flight still names it.

A `draft` frame is the sentence the agent is in the middle of writing, and it
is the one frame here that does not come from a file. Claude Code appends an
assistant entry only once the message is finished — the record carries
`stop_reason` and a token count — so a reader tailing the transcript waits out
the whole answer and then receives it in one piece, however long it took. The
terminal has the words as they arrive, because the terminal is what is drawing
them, so while a session is `working`, is open on a phone, and lives in a
multiplexer pane, the desktop reads that pane twice a second beside the file
and sends what the adapter finds there.

It is provisional by construction and is marked as one all the way to the
screen. `append` is the draft the reader already has plus a few more words —
the shape it takes nearly every time, and the reason this costs words rather
than paragraphs — `text` replaces it outright when a rewrap breaks the prefix,
and `text: ""` retires it. A draft is always retired: either explicitly, or by
the `blocks` frame that delivers the same words parsed, which the reader should
treat as the end of the draft whichever arrives first. Nothing is ever built on
a draft — it carries no `seq`, nothing expands out of it, and a reader that
ignores the frame entirely sees exactly what it saw before drafts existed.

A session with no pane sends none: the compositor road has no screen to read,
and its conversation arrives a message at a time as it always did.

A `control` frame is the desktop turning reading on or off under a live link —
the switch on its panel, or the CLI. `capabilities.agents.enabled` was answered
once at `hello` and this is how that answer changes without reconnecting: the
app patches the capability in place, then lists the sessions.

`capabilities.agents` is `{ enabled, adapters, read, write, keys, attach, answer, spawn }`.
`write` is the best road this desktop has into a terminal — `"tmux"`,
`"herdr"`, `"wtype"`, or `null` when it has none of them. A session says which
road *it* is on in its own `writable`, and the two differ often: a desktop with
tmux installed still has agents running outside it.

#### Answering

Nothing may push bytes into a terminal another process owns — `TIOCSTI` is gone
— so whatever writes is either a multiplexer that owns the pty or the
compositor typing on the user's behalf. Both ship, and they are not equivalent:

- **`tmux`** is exact. The pane is tmux's own pty. A single-line message goes
  through `send-keys -l`, which is literal, so UTF-8 and emoji survive; a
  multi-line one goes through `load-buffer` + `paste-buffer -p`, because a TUI
  with bracketed paste enabled needs it to arrive as one paste rather than as a
  burst of Returns that would submit half a message. Nothing steals focus.
- **`herdr`** is the same kind of road under a different multiplexer, and the
  one a desktop full of coding agents is likely to be on. It is asked over a
  unix socket rather than by running a command, and `pane.send_input` carries
  the message and the Return that submits it in a single request — bracketing
  the paste itself when the application has asked for bracketed paste. So
  where tmux takes two writes with a gap between them, herdr takes one that
  cannot half-arrive. Its pane ids look like `w1:p1`.
- **`wtype`** is the honest fallback for an agent in a bare terminal. The
  daemon remembers what was focused, focuses the agent's window, types, and
  puts focus back. It steals focus for a moment, it interleaves with anyone
  typing at the real keyboard, and it cannot be made atomic. The app says so
  before the first send rather than after.

`omarchy-connect agent run -- claude` starts an agent in a dedicated tmux
session, attached in the current terminal, so the desktop experience is
unchanged and the phone gets the good road for free. Inside tmux or inside a
herdr pane it wraps nothing at all and says so: that terminal is already one
the phone can answer.

`agents.key` takes a whitelist, not a pass-through: `send-keys` would forward
anything, and the set worth exposing to a phone is small — `Enter`, `Escape`,
`Tab`, `Space`, `BSpace`, the four arrows, `C-c`, `C-d`, and the digits `1`–`9`
that answer a numbered permission prompt. Anything else is refused.

#### Pictures

"Why does this look wrong" is a question about a picture, and until a picture
can cross, the answer from a sofa is to get up. A terminal carries text and
nothing else, so what crosses is the file and what reaches the agent is its
*path* — not a workaround for being unable to pass an image, but how an image
is passed: an agent reads one by opening it.

The phone uploads to `POST /api/upload` with `x-oc-dest: agent` (and an upload
ticket, like any other upload), which is the
same endpoint as a file transfer through a different door. That door behaves
differently in every way that matters: it lands in a swept cache directory
(`$XDG_CACHE_HOME/omarchy-connect/agent`) rather than the share inbox, it fires
no desktop notification and touches no transfer counter, it caps at 32 MB
rather than 512, it renames to something safe to type at a prompt, and it
answers with `{ ok, name, size, path }` — the path being the whole point. It is
gated on the same switch that grants reading, because with agents off nothing
on the desktop would ever read what was dropped there.

`agents.attach` then types those paths, with the message under them. It checks
each path against the drop directory rather than trusting it: this method types
what it is handed into a shell's neighbourhood, so a phone naming
`~/.ssh/id_ed25519` gets a refusal and not a paste.

### `submitted` is an observation

A message with a picture on it is a multi-line message — the paths on their own
line, the caption underneath — and multi-line text is delivered to a TUI as a
bracketed paste rather than as keystrokes, because every Return in the middle of
one would otherwise submit half of it. A TUI that asked for bracketed paste
collects the whole run between the brackets and commits it to its input box on
its own schedule, and a Return arriving on the paste's heels is swallowed along
with it: the text lands in the composer and nothing is sent.

Both halves of that write succeed, so `submitted` used to be a lie — the flag
the method had been asked for, echoed back. `agents.send`, `agents.attach` and
`agents.command` now read the pane's composer before typing and again after the
Return, on the two roads that own a pane (`tmux`, `herdr`); a composer that is
empty afterwards, or unchanged from what it already held, is a message that
left. Anything else answers `submitted: false`, and the session is **not** moved
to `working`, because nothing was asked. A phone that gets `submitted: false`
should keep the text and the attachments and say so, rather than drawing a
working agent for a message still sitting in a composer.

On the `wtype` road the desktop owns no pane and can observe nothing, so
`submitted` there remains the flag it was given — one more thing that road
cannot promise, alongside the focus it borrows.

Nothing deletes a drop when the agent is done with it, because nothing knows
when that is — a conversation comes back to a screenshot ten minutes later as
readily as ten seconds. The directory is swept on the way in instead: a day
old, or beyond the two hundredth file.

`agents.screen` exists because the transcript is not the whole truth: a
permission prompt is drawn on the terminal and never written to disk, so the
numbered options a phone is about to answer exist only on screen. It needs a
pane; nothing else can hand over somebody else's screen.

Writes are serialised per session, so two sends cannot interleave halfway
through a paste. Nothing serialises the phone against the person at the
keyboard — nothing can.

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

## Remote access

Off by default. With it off this daemon is what it has always been: a machine
on one subnet, advertising one address, answering phones that can reach it
there.

With it on, the desktop advertises the addresses its overlay networks gave it
alongside the LAN one (see `endpoints` under **Handshake**) and answers sockets
that arrive over them. It brings up no tunnel of its own — Tailscale,
Headscale, WireGuard, ZeroTier, NetBird and the rest are the user's to run, and
all this daemon does is notice and report what they handed the machine. There
is nothing to configure but the switch: `omarchy-connect remote on`, or the
toggle on the desktop panel.

Nothing about identity changes. The phone pins the desktop's X25519 key at
pairing and, under TLS, its certificate too; those pins are what make a socket
trustworthy, and they are indifferent to which address it came in on. The
daemon accordingly never decides who is a stranger by IP range — the mistake
that has broken this in project after project — and the address matching it
does do is against its *own* addresses, to answer "which of my interfaces did
this arrive on", never "does this peer look like a friend".

### What a remote link cannot do

Every telephony capability is reported absent to a socket the desktop classed
as `remote`, and every `phone.*` method refuses it with `not available on a
remote link`. The `phone` event channel is not fanned out to it at all.

That covers mirroring, sending, call history, answering and rejecting, the
hands-free profile, the iPhone bridge — and finding the phone, which falls
under the same roof for the same reason: a search is somebody about to walk
into the next room, and a handset shouting a hundred miles away is noise in a
house nobody is standing in. It is deliberate rather than
incidental: hands-free is a Bluetooth link to a handset in this room, a
ringing card is a call someone here can pick up, and mirroring a text message
to a desktop the phone is nowhere near is carrying private mail down a tunnel
for nobody to read.

A phone on a remote link also does not count as present, so the hands-free
policy `autoConnect: "presence"` will not raise the Bluetooth profile for it.

### Refusals

A `hello` on a remote socket while the switch is off is answered with
`{ "t": "hello.err", "error": "remote access is off on this desktop — run \`omarchy-connect remote on\` there" }`
and close code `4006` — named rather than silent, because a phone dialling an
address it was legitimately handed deserves to know why the desktop stopped
answering. Switching remote off on a running daemon closes any remote socket
already open with the same code, and pushes an `endpoints` event carrying the
LAN-only list.

### Firewall

The local rule Omarchy suggests is scoped to the desktop's own subnet, and a
phone arriving through a tunnel is not on it. `omarchy-connect remote` prints a
second rule scoped to the tunnel interface instead of an address range, which
stays correct when the overlay's addressing changes:

```bash
sudo ufw allow in on tailscale0 to any port 8765 proto tcp comment 'omarchy-connect remote'
```

## Loopback endpoints

These answer only on `127.0.0.1`, because they are the CLI, a coding agent's
own hook, and the desktop client talking to a daemon they already share a
machine with.

Loopback is not on its own a boundary, though: every process the user runs
shares it, and a page in a browser can make the machine send a `no-cors` form
POST to it. These routes send an SMS from the paired phone, mint a pairing
code, unpair it and flip the remote and agent switches, so each of them asks
for four things and answers `403 { error: "localhost only" }` — the same
sentence whichever one is missing — otherwise:

- the connection arrived on loopback;
- `x-oc-local: <secret>`, where the secret is `localSecret` from the status
  file, `~/.local/state/omarchy-connect/status.json`, which is written `0600`
  and is already the file both callers read. It is minted fresh on every start,
  and a stopped daemon publishes it as `null`;
- `content-type: application/json`, which a form post cannot claim;
- no `Origin` header at all, which a request from a web page cannot avoid
  sending.

The phone-facing `x-oc-token` auth, the ticketed file routes and `/api/info`
are untouched by this: `/api/info` is how a phone finds this desktop and is
deliberately open.

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/pair-code` | — | Mints a fresh six-digit code, valid three minutes. `409 { error, device }` while a phone is paired. |
| `POST /api/offer` | `{ path }` | Offers a desktop file to connected phones. |
| `POST /api/unpair` | `{ id }` | Forgets a phone **and** hangs up its socket. |
| `POST /api/sms` | `{ to, body }` | Asks the phone to send an SMS; answers when it confirms. |
| `POST /api/call` | `{ op, id?, number?, value? }` | `op` is `answer`, `reject`, `hangup`, `dial`, `tones` or `audio`; `connect` and `disconnect` are the link itself, `bond` is the pairing underneath it (`value: "stop"` shuts the window), and `auto`, `handset` and `ringtone` take a `value`. Answers `{ ok, via }`. |
| `POST /api/otp` | `{ op, value? }` | `op` is `status`, `copy` (`value` `on`/`off`), `auto` (`value` `on`/`off`) or `test` (`value` is a message to read). Answers `{ ok, otp }`, and `test` adds `{ code, why }`. |
| `POST /api/locate` | `{ op, seconds? }` | `op` is `start` or `stop`. Rings the paired phone until somebody finds it. Answers `{ ok, locate }`. |
| `POST /api/ios` | `{ op, seconds? }` | `op` is `status`, `pair` or `stop`. Answers `{ ok, ios }`. |
| `POST /api/agent/hook` | a hook payload | A coding agent's lifecycle event. Answers `{ ok, id, state }`. |
| `POST /api/agent/control` | `{ op }` | `op` is `status`, `enable` or `disable` — the desktop's switch for reading and answering agents. Answers `{ ok, agents }`. |
| `POST /api/remote/control` | `{ op }` | `op` is `status`, `enable` or `disable` — the desktop's switch for being reachable from off its own network. Answers `{ ok, remote }`. |

`POST /api/agent/hook` is the bridge between a coding agent and this daemon:
`omarchy-connect agent hook` reads the agent's JSON on stdin, adds what only
the hook process knows — its parent pid, its `$TMUX_PANE` — and posts it here.
`omarchy-connect agent install-hooks` writes it into `~/.claude/settings.json`
for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd`,
plus `PreToolUse` and `PostToolUse` narrowed to `AskUserQuestion` — narrowed
because an unmatched tool hook would spawn a process on every `Bash` an agent
runs — without disturbing hooks anyone else installed. A hook must never
cost the agent anything, so the post has a one-second timeout, a daemon that is
not running is a silent no-op, and a payload the daemon cannot use answers 200
with an error inside rather than looking like a failed hook.

`POST /api/agent/control` is the switch on the desktop panel, and it is
loopback-only for the same reason the whole feature is off by default: whether
a phone may read and answer this desktop's agents is a decision that must be
taken at the desktop. There is no method a phone can call to grant itself
either. The
daemon writes `agents.enabled` to the config *and* starts or stops the watching
in one call, so the change lands without a restart and the phone keeps its
link; turning it off closes every transcript held open and forgets every
session before the call returns. `omarchy-connect agent enable` posts here
first and only falls back to editing the config when no daemon answers.

`unpair` goes through the daemon rather than editing the config file directly
because the running process may hold an open connection to that phone. The
config half lands either way — a write is merged into the file and the daemon
re-reads it the moment it changes — but only the daemon can drop the socket,
and a phone whose pairing is gone and whose link is not is a phone still being
answered. The CLI falls back to editing the file when no daemon answers.

## Desktop status file

The daemon publishes its whole state to
`~/.local/state/omarchy-connect/status.json` (mode 0600, `mktemp` + rename)
and rewrites it whenever anything changes — a phone connects or drops, a file
moves, a pairing code is minted or used, the address or firewall verdict
changes. It carries the daemon's identity and address, the paired device with
its live status and telemetry, recent transfers, counters, the firewall
verdict, what it would take to wake this desktop, whether TLS is on and under
which pin, the last mirrored messages and
calls, the coding agents this desktop can read and answer, and the argv needed
to invoke the CLI again.

The `agents` block is what the panel's switch is drawn from:
`{ enabled, adapters, hooks, write, running, waiting, sessions }`. `write` is
the road this desktop has into a terminal — `"tmux"`, `"herdr"`, `"wtype"` or `null` —
which is what lets the panel say whether a session can be answered or only
watched. `adapters` and `hooks` are answers a stopped daemon still has — which agents are installed
here, and whether their lifecycle hooks are in `~/.claude/settings.json` — so
the panel can offer the switch and the *Install hooks* button before anything
is running. `running`, `waiting` and `sessions` are the live view and are
cleared when the daemon stops, because with nothing watching they are not
stale, they are unknown.

It is the contract the Omarchy shell plugin reads; anything else that wants to
watch this daemon can read it too. `OMARCHY_CONNECT_STATE` moves it aside for
tests or a second daemon. A `running: true` snapshot whose writer was killed
outright stays behind until something probes loopback — `omarchy-connect
status --json` does exactly that and rewrites the file with the truth.

## Wake on LAN

The one feature whose premise is that this daemon is not running. Nothing can
be requested at the time it is used, so everything needed is handed over during
the handshake, while the desktop is still awake, and the phone stores it beside
the pairing:

```jsonc
{ "supported": true, "interface": "enp8s0", "type": "ethernet",
  "mac": "04:42:1a:9a:7a:59", "broadcast": "192.168.1.255", "port": 9,
  "armed": false, "command": "nmcli connection modify \"Wired connection 1\" 802-3-ethernet.wake-on-lan magic",
  "note": "this desktop's network card is not set to wake it" }
```

`broadcast` comes from the interface's own address and netmask, because that is
where a magic packet has to go: the machine it is for is asleep, answers no ARP
request, and cannot be unicast to. The phone falls back to its own /24 and then
to `255.255.255.255` when the desktop gave none, and sends to ports 9 and 7,
three times each — nothing acknowledges a magic packet, and nothing retransmits
one.

`armed` is read from `/sys/class/net/<iface>/device/power/wakeup` rather than
from `ethtool`. It answers the same question from the other side — a driver that
accepts `wol g` calls `device_set_wakeup_enable()`, which is that file — and it
answers it without privileges, where reading the wake-on-lan word through
`ETHTOOL_GWOL` needs `CAP_NET_ADMIN`. `null` means the card exposes no such
flag and the question has no answer here. `command` is advice and nothing else:
the daemon never changes a network setting, exactly as it never opens a
firewall port.

The packet itself is 102 bytes — six `0xFF`, then the MAC sixteen times — and
is built on the phone, in `app/src/lib/wol.ts`, so the suite can check it byte
for byte. All the native half does is put a datagram on the wire, which is the
one thing the React Native runtime cannot do: it has no UDP socket, at any
price, which is why waking is Android-only.

The same block is published in the desktop status file, so the panel and
`omarchy-connect wake` read the answer the phone was given.

## File transfer

### Tickets

The HTTP file roads are authorised by a **ticket**, never by the device token.
A ticket is 32 random bytes, good for one request, in one direction, for two
minutes, and it is minted only over the encrypted WebSocket — `share.ticket`
with `use: "upload"` or `use: "download"` — which already knows which device is
asking. It travels in `x-oc-ticket`, and there is no fallback: `x-oc-token` and
`?token=` are refused with `401` on both roads.

The point is what a listener gets. The device token is a phone's whole
identity — with it a stranger completes their own key exchange on `/ws` and
owns the desktop — and it used to ride on every upload header and in every
download query string, in cleartext whenever TLS was off, which is the default.
A query string is also the part of a request that gets written down, in proxy
logs and URL histories, so it outlived the transfer by years. A stolen ticket
buys the one file that was already on the wire in front of the thief, cannot be
replayed, and is worthless by the time anyone reads it out of a log.

Both roads also answer `403 { "error": "remote access is off …" }` to a request
that arrived over a tunnel while remote access is off — the same gate, decided
the same way (by the interface the connection came in on), as the `hello` that
a remote WebSocket gets.

**Phone → desktop.** `POST /api/upload` with `x-oc-ticket` and `x-oc-filename`.
The body streams straight to `~/Downloads/Omarchy Connect/`, never overwriting
(`report.pdf` becomes `report (2).pdf`). Capped at 512 MB; a partial upload is
deleted. The desktop raises a notification on arrival.

The filename is percent-encoded, because a header cannot carry a newline or a
Cyrillic letter. A value that is not valid percent-encoding — `100%.txt`, or an
escape the encoder cut in half — is answered with `400
{ "error": "filename is not valid percent-encoding" }` rather than guessed at.
What survives decoding keeps its spaces and its alphabet, and loses only what
is not filename material: separators, so a name cannot climb out of the inbox,
and NUL and the other control characters. (An agent drop is stricter still —
see **Pictures** under `agents` — because that path's name is going to be
typed at a prompt as a bare word.)

## Security model

- The control channel — every command, every event, the clipboard, notification
  text and file names — is encrypted end to end and the desktop is
  authenticated by a pinned key. See **Encryption** above.
- **File bodies are the exception, unless TLS is on.** `/api/upload` and
  `/api/download` are authenticated by a one-use ticket minted over the
  encrypted socket, and the offer tokens and file names that set them up travel
  encrypted — but with TLS off the bytes themselves do not, and someone already
  on your LAN could read a file in flight. What they cannot do any more is
  read a credential out of that traffic: a ticket is spent on the request they
  are watching, and the device token never goes near HTTP. `omarchy-connect tls enable` closes this for any client that can pin
  the certificate; Expo Go and iOS cannot, and stay exposed.
- **Mirrored messages are as sensitive as the messages themselves.** SMS bodies
  and caller names cross the WebSocket, so they are encrypted end to end — but
  they also land in the desktop's notification history and in the status file
  (mode 0600). Granting the permission is a deliberate act in the app, never
  something asked for at startup.
- **Reading a coding agent is reading everything it saw** — source, tool
  output, whatever secrets crossed a `Bash` result — and **writing to one is
  arbitrary code execution**: the agent runs what it is told, so a phone that
  can type into a Claude Code session has, in effect, a shell. Together they
  are the widest exposure in the project, wider than the clipboard, so
  `agents.spawn` is a **second** switch, off even when reading is on:
  starting a process that was not there before is not the same decision as
  reading one somebody already started. `omarchy-connect agent spawn on`.

  `agents.enabled` defaults to **false** and is turned on by
  `omarchy-connect agent enable` — or the switch on the desktop panel, which
  names both halves before it grants either. Both roads are the desktop's: the
  endpoint behind them answers on loopback only, so no paired phone can turn on
  its own ability to read or write. Writing is bounded in what it can be, not
  in what it can say: `agents.key` takes a whitelist rather than forwarding key
  sequences, and a message is capped at 4096 characters. Neither bound makes
  the grant smaller — it is still a shell — they only keep the surface itself
  small enough to reason about.
- Every method call requires a paired token. There is no anonymous access.
- One phone is paired at a time, so exactly one token is live; pairing a
  different phone means unpairing this one first.
- Input injection is reachable by the paired phone: pairing grants control of
  the pointer and keyboard, and should be treated accordingly.
- `system.openUrl` accepts only `http(s)`, so it cannot be used as a generic
  "launch anything" primitive.
- Shutdown, reboot and logout require an explicit `confirm: true`.
- File offers expire after 30 minutes and their tokens are single-purpose.

Treat pairing the way you treat handing someone your unlocked laptop: only pair
a phone you own.
