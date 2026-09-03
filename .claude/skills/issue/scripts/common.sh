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
