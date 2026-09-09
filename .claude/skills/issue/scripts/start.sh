#!/usr/bin/env bash
# Open a worktree for one issue, from a fresh master, with node_modules linked in.
# Prints the worktree path last, on its own line.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
n="${1:?issue number}"
class="$(issue_class "$n")"
[ -n "$class" ] || die "issue #$n has no harness:* label — run /issue-plan"
branch="issue-$n"
wt="$WORKTREES/$branch"

hdr "master"
git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet || die "master checkout is dirty — commit or stash first"
git -C "$REPO" checkout -q master
git -C "$REPO" pull -q --ff-only origin master || die "master does not fast-forward to origin"

hdr "worktree"
if [ -d "$wt" ]; then
  echo "reusing $wt (a previous attempt left it)"
else
  git -C "$REPO" worktree add -q "$wt" -b "$branch" master 2>/dev/null \
    || git -C "$REPO" worktree add -q "$wt" "$branch" \
    || die "could not add worktree"
fi
for pkg in daemon app; do
  [ -e "$wt/$pkg/node_modules" ] || ln -s "$REPO/$pkg/node_modules" "$wt/$pkg/node_modules"
done
# The native project is not in git. The apk class needs a real copy, because
# gradle resolves ../ from wherever android/ physically is.
if [ "$class" = apk ] && [ ! -d "$wt/app/android" ]; then
  echo "copying app/android (native project is generated, not tracked)"
  rsync -a --exclude build --exclude .gradle --exclude .cxx "$REPO/app/android/" "$wt/app/android/"
fi
copy_desktop_ca "$REPO" "$wt"
mkdir -p "$STATE/$n"
echo "class=$class branch=$branch" | tee "$STATE/$n/meta"

hdr "issue #$n ($class)"
gh issue view "$n" --json title,body -q '"# " + .title + "\n\n" + .body'
echo
echo "$wt"
