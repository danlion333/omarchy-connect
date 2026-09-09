#!/usr/bin/env bash
# Shared by every script in this skill. Source it; do not run it.
set -uo pipefail

export PATH="$PATH:$HOME/Android/Sdk/platform-tools"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SKILL_DIR="$REPO/.claude/skills/issue"
QUEUE="$SKILL_DIR/queue.txt"
WORKTREES="$REPO/.claude/worktrees"
STATE="${OMARCHY_HARNESS_DIR:-$HOME/.local/state/omarchy-connect/harness}"
PKG=dev.omarchy.connect
UNIT=omarchy-connect
DROPIN="$HOME/.config/systemd/user/$UNIT.service.d/harness.conf"

mkdir -p "$STATE"

hdr() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Everything from here to die() exists so that a caller — a subagent, or the
# dispatcher above it — can run a whole issue without its transcript filling up
# with suite output, gradle noise and logcat. A script that calls quiet_to sends
# all of that to a file and keeps stdout for the one line that says how it went.
# The detail is not lost; it is just in nobody's context until explain.sh asks
# for the part that matters.
QUIET=""
quiet_to() {
  LOGFILE="$1"
  : > "$LOGFILE"
  exec 3>&1          # fd 3 stays the real stdout, reserved for the verdict
  exec >>"$LOGFILE" 2>&1
  QUIET=1
}

# Put something on the real stdout even in quiet mode, and in the log as well so
# the log still reads as the whole story.
say() {
  if [ -n "$QUIET" ]; then echo "$*" >&3; fi
  echo "$*"
}

# The single line that says where an issue stands. Written to RESULT so a run
# that was interrupted can be picked up, and printed last so a caller can read
# it straight off stdout without opening a file. One of:
#   VERDICT green | red <why> | phone-missing | merged | handover | blocked <why>
verdict() {
  local n="$1"; shift
  mkdir -p "$STATE/$n"
  echo "VERDICT $*" > "$STATE/$n/RESULT"
  say "VERDICT $*"
}

die() { echo "error: $*" >&2; if [ -n "$QUIET" ]; then echo "error: $*" >&3; fi; exit 1; }

# The class of an issue, from its harness:* label. Empty when unplanned.
issue_class() {
  gh issue view "$1" --json labels -q '.labels[].name' | sed -n 's/^harness:\(auto\|apk\|human\)$/\1/p' | head -1
}

# Which top-level areas a branch touches, relative to master.
touched_areas() {
  git -C "$1" diff --name-only master...HEAD | cut -d/ -f1 | sort -u | tr '\n' ' '
}

phone_present() { adb get-state >/dev/null 2>&1; }

# The app will not bring the link up while the screen is off, and a screenshot
# taken then is a black rectangle. Wake and unlock before anything on-phone.
wake_phone() {
  local state
  state="$(adb shell dumpsys display 2>/dev/null | grep -m1 -o 'mScreenState=[A-Z_]*')"
  echo "screen before: ${state:-unknown}"
  grep -q 'ON' <<<"$state" || adb shell input keyevent 224   # KEYCODE_WAKEUP
  sleep 1
  adb shell input keyevent 82                                # dismiss the keyguard
  sleep 1
  state="$(adb shell dumpsys display 2>/dev/null | grep -m1 -o 'mScreenState=[A-Z_]*')"
  echo "screen after: ${state:-unknown}"
  grep -q 'ON' <<<"$state"
}

# The desktop's own certificate, copied from one checkout into another.
#
# `omarchy-connect tls trust` writes `app/assets/desktop-ca.pem`, and
# `app/.gitignore` keeps it out of git on purpose: it belongs to one machine,
# not to the project. A worktree cut from master therefore never has it, and
# `plugins/withDesktopCa.js` reads it off the project root it is prebuilding —
# so a prebuild in a worktree silently takes the branch that ships no trust
# anchor at all, and the APK that comes out cannot verify the desktop it is
# supposed to dial. That failure looks like a broken network from every angle
# except the one that explains it, which cost #58 and #57 a red verification
# each. So every worktree gets the file, whatever the issue's class is.
#
# A checkout that has never run `tls trust` has nothing to copy, and that is
# not an error: it is a desktop with no certificate yet, and saying so is all
# this can usefully do.
copy_desktop_ca() {
  local from="$1" to="$2" rel="app/assets/desktop-ca.pem"
  if [ ! -f "$from/$rel" ]; then
    echo "no $rel in $from — run 'omarchy-connect tls trust' before building an APK"
    return 0
  fi
  mkdir -p "$to/app/assets"
  cp -p "$from/$rel" "$to/$rel"
  echo "copying $rel (this desktop's certificate, generated and not tracked)"
}
