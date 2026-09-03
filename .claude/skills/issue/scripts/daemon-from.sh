#!/usr/bin/env bash
# Point the running daemon at a worktree (or back at master with --reset) and
# restart it. Succeeds only when the Main PID changed and the daemon printed its
# summary; a unit that died and came back also reads "active", so PID is the test.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
target="${1:?worktree path or --reset}"
before="$(systemctl --user show -p MainPID --value "$UNIT")"
if [ "$target" = --reset ]; then
  rm -f "$DROPIN"; echo "drop-in removed — daemon runs from $REPO again"
else
  [ -f "$target/daemon/bin/omarchy-connect.js" ] || die "$target is not a checkout"
  node="$(systemctl --user show -p ExecStart --value "$UNIT" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
  [ -n "$node" ] || node="$(command -v node)"
  mkdir -p "$(dirname "$DROPIN")"
  printf '[Service]\nExecStart=\nExecStart=%s %s/daemon/bin/omarchy-connect.js start\n' "$node" "$target" > "$DROPIN"
  echo "drop-in written — daemon runs from $target"
fi
systemctl --user daemon-reload
systemctl --user restart "$UNIT"
for _ in $(seq 1 15); do
  sleep 1
  after="$(systemctl --user show -p MainPID --value "$UNIT")"
  [ "$after" != "$before" ] && [ "$after" != 0 ] && break
done
[ "$after" != "$before" ] && [ "$after" != 0 ] || { journalctl --user -u "$UNIT" -n 30 --no-pager; die "daemon did not come up with a new PID"; }
echo "pid $before -> $after"
systemctl --user show -p ExecStart --value "$UNIT" | sed -n 's/.*argv\[\]=\([^;]*\).*/\1/p'
