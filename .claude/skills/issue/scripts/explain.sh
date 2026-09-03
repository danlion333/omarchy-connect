#!/usr/bin/env bash
# Print just the part of a verification that went wrong, and nothing else.
#   explain.sh <n> [what]
# what is one of: fail (the default — whatever verify.json complained about),
# suites, typecheck, daemon, apk, phone, or log for the whole thing.
#
# This is the other half of the quiet verify.sh. The log holds everything, but
# reading it whole is exactly the habit that fills a context up; ask for the
# section that failed and read fifty lines instead of two thousand.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
n="${1:?issue number}"; what="${2:-fail}"
out="$STATE/$n"
log="$out/verify.log"
[ -f "$log" ] || die "no verify.log for #$n — run verify.sh first"

# One section of the log, from its `== name` header to the next header. The
# headers carry the bold escapes hdr() wrote, hence the loose match.
section() {
  awk -v want="$1" '
    /^\x1b\[1m== / || /^== / {
      line = $0; gsub(/\x1b\[[0-9;]*m/, "", line)
      sub(/^== /, "", line)
      inside = (index(line, want) == 1)
    }
    inside { print }
  ' "$log"
}

case "$what" in
  suites)
    if [ -f "$out/tests.json" ]; then
      hdr "suites that did not pass"
      jq -r '.suites[] | select(.status != "passed")
             | "--- \(.suite) [\(.status)]\n\(.message // .error // "")"' "$out/tests.json"
    fi
    section suites
    ;;
  typecheck) section typecheck ;;
  apk)       section "release apk" ;;
  phone)     section "phone state"; section phone ;;
  daemon)
    section phone
    hdr "worktree daemon journal"
    journalctl --user -u "$UNIT" -n 80 --no-pager
    ;;
  log)  cat "$log" ;;
  fail)
    v="$out/verify.json"
    [ -f "$v" ] || die "no verify.json for #$n"
    mapfile -t reasons < <(jq -r '.fail[]?' "$v")
    if [ "${#reasons[@]}" = 0 ]; then
      say "#$n has nothing in verify.json's fail list — the verdict was $(cat "$out/RESULT" 2>/dev/null)"
      exit 0
    fi
    for r in "${reasons[@]}"; do
      case "$r" in
        suites*)                    "$0" "$n" suites ;;
        typecheck*)                 "$0" "$n" typecheck ;;
        *apk*)                      "$0" "$n" apk ;;
        *daemon*|*never\ connected*) "$0" "$n" daemon ;;
        *crashed*)                  "$0" "$n" phone ;;
        *) echo "$r — no section maps to this; try: explain.sh $n log" ;;
      esac
    done
    ;;
  *) die "unknown section '$what' — fail|suites|typecheck|daemon|apk|phone|log" ;;
esac
