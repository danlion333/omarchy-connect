#!/usr/bin/env bash
# One-shot picture of the phone, the build on it, and the desktop it talks to.
# Read this before theorising about any device-side bug.
set -uo pipefail

export PATH="$PATH:$HOME/Android/Sdk/platform-tools"
PKG=dev.omarchy.connect
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

hdr() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

hdr "device"
adb devices -l || exit 1
adb get-state >/dev/null 2>&1 || {
  echo "no device in 'device' state — see SKILL.md, 'Getting the phone to appear'"
  hdr "usb (kernel view)"
  for d in /sys/bus/usb/devices/*/; do
    [ -f "$d/idVendor" ] || continue
    echo "$(cat "$d/idVendor"):$(cat "$d/idProduct")  $(cat "$d/product" 2>/dev/null)"
    for i in "$d"*:*/; do
      [ -d "$i" ] || continue
      echo "   iface class=$(cat "$i/bInterfaceClass") sub=$(cat "$i/bInterfaceSubClass")"
    done
  done
  exit 1
}

echo "android $(adb shell getprop ro.build.version.release | tr -d '\r')" \
     "(sdk $(adb shell getprop ro.build.version.sdk | tr -d '\r'))" \
     "$(adb shell getprop ro.product.model | tr -d '\r')" \
     "$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

hdr "build"
if adb shell pm list packages | grep -q "^package:$PKG$"; then
  adb shell dumpsys package "$PKG" \
    | grep -E "versionName|versionCode|lastUpdateTime|installerPackageName" \
    | sed 's/^ *//' | sort -u
  # Sideloaded via a messenger => notification access is a "Restricted setting".
  adb shell dumpsys package "$PKG" | grep -q "installerPackageName=com.android.packageinstaller" \
    || echo "note: not installed by adb/packageinstaller — notification access may be restricted"

  # A debug build has no JS in it — it needs Metro on 8081 or it shows the red
  # "Unable to load script" screen. See SKILL.md for the fix.
  if adb shell dumpsys package "$PKG" | grep -m1 'flags=\[' | grep -q DEBUGGABLE; then
    echo "DEBUGGABLE build — loads JS from Metro, not from the APK"
    if ss -ltn 2>/dev/null | grep -q ':8081 '; then
      adb reverse --list 2>/dev/null | grep -q 'tcp:8081' \
        && echo "  metro up on 8081, reverse in place" \
        || echo "  metro up on 8081 but NO reverse — run: adb reverse tcp:8081 tcp:8081"
    else
      echo "  NO metro on 8081 — app will fail to load JS (cd app && npx expo start --dev-client)"
    fi
  else
    echo "release build — JS bundle embedded, Metro not needed"
  fi
else
  echo "$PKG NOT INSTALLED — cd app && npx expo run:android"
  exit 0
fi

hdr "permissions"
adb shell dumpsys package "$PKG" | grep -E "granted=(true|false)" | sed 's/^ *//' \
  | sed 's/, flags.*//' | sed 's/android.permission.//' | sort -t: -k2 -r

hdr "notification access (caller ID)"
if adb shell settings get secure enabled_notification_listeners | grep -q "$PKG"; then
  echo "granted"
else
  echo "NOT granted — caller ID will report 'unknown' while the phone rings"
fi

hdr "process and services"
PID=$(adb shell pidof "$PKG" | tr -d '\r')
[ -n "$PID" ] && echo "running, pid $PID" || echo "not running"
adb shell dumpsys activity services "$PKG" 2>/dev/null \
  | grep -E "ServiceRecord\{|isForeground|createTime|crashCount|restartCount" \
  | sed 's/^ *//' || echo "no services"

hdr "network"
echo "phone:   $(adb shell ip route get 1.1.1.1 2>/dev/null | tr -d '\r' | grep -oP 'src \K[\d.]+')"
echo "desktop: $(ip -4 addr show scope global | grep -oP 'inet \K[\d.]+' | head -1)"
adb reverse --list 2>/dev/null | grep . | sed 's/^/reverse: /' || echo "reverse: none (real LAN path)"

hdr "app logs (last 20 of this pid)"
if [ -n "$PID" ]; then
  OUT=$(adb logcat -d --pid="$PID" -t 20 2>/dev/null)
  [ -n "$OUT" ] && echo "$OUT" \
    || echo "(empty — the Kotlin modules emit no Log.* yet; absence proves nothing)"
fi

hdr "daemon"
node "$REPO/daemon/bin/omarchy-connect.js" status 2>&1 | head -20
