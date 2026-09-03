---
name: adb-phone
description: Drive a real Android phone over USB with adb to test and debug this app — install a build, read native logs, inspect foreground-service and permission state, capture the screen, force a reconnect, survive a reboot. Use when the phone is plugged in (or should be), when a telephony / background-link / pairing bug needs the device's own state rather than a guess, or when asked to check, install, screenshot, or log anything on the phone.
---

# Testing this app on a real phone over adb

The Android half of Omarchy Connect — `omarchy-telephony` and `omarchy-link` — does
not exist in Expo Go. SMS, call state, `TelecomManager.answer` and the foreground
service only run in a real build, and when one of them misbehaves the evidence is on
the device, not in Metro. This is how to get at it.

## Setup

`ANDROID_HOME` on this machine points at `/opt/android-sdk`, which does not exist. The
SDK is at `~/Android/Sdk` and `adb` is not on `PATH`. The Bash tool does not keep shell
state between calls, so **every** call that uses adb must start with:

```bash
export PATH="$PATH:$HOME/Android/Sdk/platform-tools"
```

Worth offering the user once, so this stops recurring:

```bash
# ~/.bashrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
```

## Getting the phone to appear

`adb devices -l` and read the state:

| What you see | What it means | Fix |
| --- | --- | --- |
| empty list | no adb interface exposed | see below |
| `unauthorized` | RSA dialog not accepted | tap **Allow** on the phone, tick "always allow"; then `timeout 90 adb wait-for-device` |
| `no permissions` | udev rule missing | `sudo pacman -S android-udev`, replug |
| `device` | ready | — |

An empty list with the phone plugged in is usually the **USB mode**, not a driver
problem. Check what the kernel sees before guessing:

```bash
for d in /sys/bus/usb/devices/*/; do
  [ -f "$d/idVendor" ] || continue
  echo "$(cat $d/idVendor):$(cat $d/idProduct)  $(cat $d/product 2>/dev/null)"
  for i in "$d"*:*/; do [ -d "$i" ] || continue
    echo "   iface class=$(cat $i/bInterfaceClass) sub=$(cat $i/bInterfaceSubClass)"
  done
done
```

`lsusb` is not installed here. The adb interface is `class=ff sub=42 proto=01` — if the
phone only shows `class=01` (audio/MIDI) or `class=06` (PTP) alone, USB debugging is off
or the connection mode is wrong. On the paired OnePlus 9 Pro, `18d1:4ee8` is MIDI-only
(no adb) and `22d9:2765` is MTP+adb. Tell the user to enable **Developer options →
USB debugging** and set the USB mode to **File transfer (MTP)**.

## What is on the device

```
package        dev.omarchy.connect
activity       dev.omarchy.connect/.MainActivity
foreground svc expo.modules.omarchylink.LinkService          (background link)
listener svc   expo.modules.omarchytelephony.CallNotifications (caller ID)
receivers      .SmsReceiver  .PhoneStateReceiver  .BootReceiver
```

Run `scripts/state.sh` for the whole picture in one shot — device, build, permissions,
services, notification access, pairing state. Read it before forming any theory.

## Recipes

### Build and install

```bash
cd app && npx expo run:android            # builds and installs over USB
adb install -r path/to/app.apk            # a prebuilt APK
```

Prefer `adb install` over sideloading through a messenger: on Android 13+ an app whose
installer is a chat app has **notification access greyed out as "Restricted setting"**,
which silently kills caller ID. Installing over adb never hits that block.

A **debug** build carries no JS: `app/android/app/build/outputs/apk/debug/app-debug.apk`
has no `assets/index.android.bundle` in it and fetches the code from Metro every launch.
The **release** APK embeds the bundle and needs nothing running on the desktop. For
testing the app the way a user meets it, install the release one:

```bash
adb install -r app/android/app/build/outputs/apk/release/app-release.apk
unzip -l <apk> | grep index.android.bundle    # which kind of APK is this
adb shell dumpsys package dev.omarchy.connect | grep -m1 'flags=\['   # DEBUGGABLE?
```

### The red "Unable to load script" screen

`Unable to load script … make sure your bundle 'index.android.bundle' is packaged
correctly` with a `loadJSBundleFromAssets` stack is **not** a bug in the app's code. It
means a debug build launched with nowhere to fetch JS from. It appears before a single
line of JS runs, so no recent commit to `app/src/`, `daemon/` or `shell/` can cause it —
check that claim before chasing one:

```bash
git log --oneline -20 -- app/android app/app.json app/plugins app/modules   # native churn
cd app && npx tsc --noEmit
cd app && npx expo export:embed --platform android --dev false \
  --bundle-output "$SCRATCH/index.android.bundle" --assets-dest "$SCRATCH"   # does it bundle at all
```

The three things to check on the device side, in order:

```bash
adb shell dumpsys package dev.omarchy.connect | grep -m1 'flags=\['  # DEBUGGABLE => needs Metro
ss -ltnp | grep :8081                                                # is Metro even up
adb reverse --list                                                   # is 8081 forwarded
```

Fix — start Metro, forward the port, relaunch:

```bash
cd app && npx expo start --dev-client --port 8081   # background it
curl -sf http://localhost:8081/status               # wait for "packager-status:running"
adb reverse tcp:8081 tcp:8081
adb shell am force-stop dev.omarchy.connect
adb shell am start -n dev.omarchy.connect/.MainActivity
```

`adb reverse` does not survive a phone reboot or a replugged cable, and `expo
run:android` only sets it at install time — so a debug build that worked yesterday shows
this screen today with nothing having changed in the repo. That is the usual story.

A screenshot straight after the relaunch can come back all black: the screen is off, not
the app broken. `adb shell input keyevent KEYCODE_WAKEUP` first, and confirm with
`adb shell dumpsys window | grep mCurrentFocus`.

### Logs

```bash
adb logcat -c                                             # clear, then reproduce
adb logcat -d --pid=$(adb shell pidof dev.omarchy.connect | tr -d '\r')
adb logcat -d -s ReactNativeJS:V                          # JS console.*
adb logcat -d | grep -i omarchy                           # system's view of the app
```

**The Kotlin modules currently emit no `Log.*` at all.** A filtered logcat comes back
empty and that is not evidence of anything. Until logging is added, fall back to
`dumpsys` for service state, and say plainly that the native path is unobservable rather
than concluding it did not run.

### Service and permission state

```bash
adb shell dumpsys activity services dev.omarchy.connect   # isForeground, crashCount, restartCount
adb shell dumpsys package dev.omarchy.connect | grep -E "granted=(true|false)"
adb shell settings get secure enabled_notification_listeners | tr ':' '\n' | grep omarchy
```

Grant what a test needs instead of asking the user to tap through settings. **Ask first
for `SEND_SMS`** — it lets the app send real messages from the user's number.

```bash
adb shell pm grant dev.omarchy.connect android.permission.POST_NOTIFICATIONS
adb shell pm grant dev.omarchy.connect android.permission.SEND_SMS
adb shell pm revoke dev.omarchy.connect android.permission.READ_CONTACTS   # test the degraded path
adb shell cmd notification allow_listener dev.omarchy.connect/expo.modules.omarchytelephony.CallNotifications
```

A denied `POST_NOTIFICATIONS` hides the foreground service's notification while the
service keeps running — it looks exactly like a broken background link. Check the
permission before believing that report.

### The screen

```bash
adb exec-out screencap -p > "$SCRATCH/screen.png"   # then Read the file
adb shell input tap 540 1200
adb shell input text 'hello'
adb shell input keyevent KEYCODE_BACK
adb shell screenrecord --time-limit 20 /sdcard/r.mp4 && adb pull /sdcard/r.mp4
```

### Lifecycle — the cases this app exists to survive

```bash
adb shell am force-stop dev.omarchy.connect            # kill; link should come back
adb shell am start -n dev.omarchy.connect/.MainActivity
adb shell svc wifi disable && adb shell svc wifi enable  # reconnect / onNetworkChange
adb reboot                                             # BootReceiver restarts LinkService
```

Wi-Fi off is safe here precisely because adb rides USB — the observation channel
survives the failure being tested. That is the whole argument for testing this over a
cable. After `adb reboot`, `timeout 180 adb wait-for-device` then re-check `dumpsys
activity services`.

### Networking

```bash
adb shell ip route get 1.1.1.1        # the phone's LAN address
adb reverse tcp:8081 tcp:8081         # Metro over USB — no ufw hole needed
adb reverse tcp:8765 tcp:8765         # the daemon over USB
adb reverse --list && adb reverse --remove-all
```

`adb reverse` makes the desktop reachable at `127.0.0.1` from the phone, which sidesteps
Omarchy's `ufw` `DROP` policy entirely. Do **not** use it to test pairing discovery,
subnet sweep, or "follows the desktop" — those need the real LAN path.

### Battery and stats cards

```bash
adb shell dumpsys battery                       # compare against what the app reports
adb shell dumpsys battery set level 15
adb shell dumpsys battery reset                 # ALWAYS restore
```

## What adb cannot do on a real device

- **Fake an incoming SMS or call.** `SMS_RECEIVED` is signature-protected; `am broadcast`
  cannot send it. Testing telephony needs a second number, or an emulator
  (`adb emu sms send +1555 'text'`). Never claim a telephony path was tested when it was
  not actually exercised.
- **Route call audio.** Android has blocked non-system apps from call audio since 10;
  the Bluetooth road in the README is the answer, not a bug to chase.
- **Substitute for the daemon side.** Pair state, encryption and capability negotiation
  live on the desktop — read them with `node daemon/bin/omarchy-connect.js status`.

## Before finishing

Undo what the test changed: `dumpsys battery reset`, `adb reverse --remove-all`, Wi-Fi
back on, permissions restored if a degraded path was being exercised. Report what was
actually observed on the device, and say which parts were not reachable over adb.
