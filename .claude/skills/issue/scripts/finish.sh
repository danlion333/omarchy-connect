#!/usr/bin/env bash
# Land a green worktree: merge into master (no-ff), push, close or hand over the
# issue, restore the daemon and panel, drop the worktree.
#   finish.sh <n> <worktree> <summary-file>
# summary-file is the comment posted on the issue: what changed and what was
# actually observed. For harness:human it must contain the manual checklist.
# The merge, the push and the panel reinstall all go to $STATE/<n>/finish.log;
# stdout is one line, VERDICT merged or VERDICT handover.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
n="${1:?issue}"; wt="${2:?worktree}"; summary="${3:?summary file}"
mkdir -p "$STATE/$n"; quiet_to "$STATE/$n/finish.log"
class="$(issue_class "$n")"
branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
v="$STATE/$n/verify.json"
[ -f "$v" ] || die "no verify.json — run verify.sh first"
[ "$(jq -r .suites "$v")" = green ] || die "verify.json is not green; nothing is merged"
[ "$(jq -r .phone "$v")" = present ] || die "verify ran without the phone; plug it in and verify again"
git -C "$wt" diff --quiet && git -C "$wt" diff --cached --quiet || die "worktree has uncommitted changes"
[ "$(git -C "$wt" rev-list --count master..HEAD)" -gt 0 ] || die "branch has no commits over master"

hdr "merge"
areas="$(touched_areas "$wt")"
git -C "$REPO" checkout -q master
git -C "$REPO" merge --no-ff -q -m "Merge issue #$n: $(gh issue view "$n" --json title -q .title)" "$branch" || die "merge conflict — resolve in $REPO, then rerun"
git -C "$REPO" push -q origin master || die "push failed"
echo "merged $branch -> master, pushed"

hdr "daemon and panel back on master"
"$SKILL_DIR/scripts/daemon-from.sh" --reset
if grep -q shell <<<"$areas"; then
  node "$REPO/daemon/bin/omarchy-connect.js" panel install && omarchy-restart-shell
fi

hdr "issue"
if [ "$class" = human ]; then
  gh issue comment "$n" --body-file "$summary" >/dev/null
  gh issue edit "$n" --add-label harness:verify >/dev/null
  echo "#$n merged, left open with harness:verify — a person closes it after the checklist"
else
  gh issue close "$n" --comment "$(cat "$summary")" >/dev/null
  echo "#$n closed"
fi

hdr "cleanup"
git -C "$REPO" worktree remove --force "$wt" && git -C "$REPO" branch -d "$branch" >/dev/null
echo "worktree gone"

# handover, not merged, when a person still has a checklist to work through —
# the dispatcher counts those separately when the queue ends.
if [ "$class" = human ]; then
  verdict "$n" handover "merged, left open with harness:verify"
else
  verdict "$n" merged "closed #$n"
fi
