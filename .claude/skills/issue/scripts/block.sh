#!/usr/bin/env bash
# Give up on an issue for now: say why on the issue, label it, put the daemon
# back on master. The worktree stays for a person to look at.
#   block.sh <n> <reason-file>
# The first line of the reason file becomes the verdict's summary, so write it
# as one sentence a person can act on; the rest of the file is the detail that
# goes on the issue.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
n="${1:?issue}"; reason="${2:?reason file}"
mkdir -p "$STATE/$n"; quiet_to "$STATE/$n/block.log"
gh issue comment "$n" --body-file "$reason" >/dev/null
gh issue edit "$n" --add-label harness:blocked >/dev/null
"$SKILL_DIR/scripts/daemon-from.sh" --reset >/dev/null
echo "#$n blocked; worktree kept at $WORKTREES/issue-$n; daemon back on master"
verdict "$n" blocked "$(head -1 "$reason")"
