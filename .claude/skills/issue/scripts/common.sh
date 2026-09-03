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
die() { echo "error: $*" >&2; exit 1; }

# The class of an issue, from its harness:* label. Empty when unplanned.
issue_class() {
  gh issue view "$1" --json labels -q '.labels[].name' | sed -n 's/^harness:\(auto\|apk\|human\)$/\1/p' | head -1
}

# Which top-level areas a branch touches, relative to master.
touched_areas() {
  git -C "$1" diff --name-only master...HEAD | cut -d/ -f1 | sort -u | tr '\n' ' '
}

phone_present() { adb get-state >/dev/null 2>&1; }
