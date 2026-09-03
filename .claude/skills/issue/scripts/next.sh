#!/usr/bin/env bash
# The next issue to do: first in queue.txt that is still open, planned, and not
# blocked. Prints the number, or nothing (exit 1) when the queue is done.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -f "$QUEUE" ] || die "no queue — run /issue-plan first"
open="$(gh issue list --state open --limit 100 --json number,labels \
  -q '.[] | select(.labels | map(.name) | (index("harness:blocked") | not) and (index("harness:verify") | not)) | .number')"
while read -r n _; do
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  grep -qx "$n" <<<"$open" || continue
  [ -n "$(issue_class "$n")" ] || continue
  echo "$n"; exit 0
done < "$QUEUE"
echo "queue is empty — nothing left that is open, planned and unblocked" >&2
exit 1
