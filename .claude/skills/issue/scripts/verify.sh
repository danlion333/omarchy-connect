#!/usr/bin/env bash
# Everything that can be checked without a person: the suites, the typecheck,
# and — with the phone on the cable — the daemon from this worktree talking to
# it. Writes $STATE/<n>/verify.json, and the whole running commentary — suites,
# gradle, journal, logcat — to $STATE/<n>/verify.log. The only thing on stdout
# is the verdict:
#   VERDICT green | red <why> | phone-missing
# When it is red, explain.sh prints the part of the log that went wrong; there
# is no reason to read the rest of it.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
n="${1:?issue number}"; wt="${2:?worktree}"
out="$STATE/$n"; mkdir -p "$out"
quiet_to "$out/verify.log"
class="$(issue_class "$n")"
areas="$(touched_areas "$wt")"
fail=()

hdr "suites ($areas)"
pkgs=""
grep -q daemon <<<"$areas" && pkgs="$pkgs daemon"
grep -q app <<<"$areas" && pkgs="$pkgs app"
[ -n "$pkgs" ] || pkgs="daemon app"
if ! node "$wt/tools/run-tests.mjs" $pkgs --report "$out/tests.json" 2>&1; then
  fail+=("suites: $(node -e 'const r=require(process.argv[1]);console.log(r.suites.filter(s=>s.status!=="passed").map(s=>s.suite).join(","))' "$out/tests.json" 2>/dev/null)")
fi

if grep -q app <<<"$areas"; then
  hdr "typecheck"
  (cd "$wt/app" && npx tsc --noEmit 2>&1) || fail+=("typecheck")
fi

hdr "phone"
if ! phone_present; then
  echo "no device — the on-phone half of this verification did not run"
  printf '{"issue":%s,"suites":"%s","phone":"missing","fail":%s}\n' "$n" "$([ ${#fail[@]} = 0 ] && echo green || echo red)" \
    "$(printf '%s\n' "${fail[@]}" | jq -R . | jq -s .)" > "$out/verify.json"
  [ ${#fail[@]} = 0 ] && verdict "$n" phone-missing || verdict "$n" red "${fail[*]}"
  exit 0
fi

if grep -q daemon <<<"$areas" || grep -q shell <<<"$areas"; then
  "$SKILL_DIR/scripts/daemon-from.sh" "$wt" || fail+=("daemon did not start from worktree")
  echo "waiting for the phone to redial…"
  ok=""
  for _ in $(seq 1 30); do
    sleep 1
    journalctl --user -u "$UNIT" --since "-45s" --no-pager -o cat | grep -q "connected from" && { ok=1; break; }
  done
  [ -n "$ok" ] && echo "phone connected to the worktree daemon" || fail+=("phone never connected to the worktree daemon")
  node "$wt/daemon/bin/omarchy-connect.js" status 2>&1 | head -20
fi

if [ "$class" = apk ] || grep -q '^app' <<<"$(git -C "$wt" diff --name-only master...HEAD | grep -v '^app/test')"; then
  hdr "release apk"
  if [ -d "$wt/app/android" ]; then
    (cd "$wt/app/android" && ./gradlew -q assembleRelease 2>&1) \
      && adb install -r "$wt/app/android/app/build/outputs/apk/release/app-release.apk" \
      || fail+=("release apk build/install")
    adb shell am force-stop $PKG; adb shell am start -n $PKG/.MainActivity >/dev/null
    sleep 8
  else
    echo "app changed but no native project in the worktree (class is $class, not apk) — JS was not run on the phone"
  fi
fi

hdr "phone state"
adb logcat -d -s OmarchyLink:W OmarchyTelephony:W AndroidRuntime:E 2>/dev/null | grep -i "omarchy\|FATAL" | tail -10
adb logcat -d -s AndroidRuntime:E 2>/dev/null | grep -q "$PKG" && fail+=("app crashed on the phone (AndroidRuntime)")
"$REPO/.claude/skills/adb-phone/scripts/state.sh" 2>&1 | sed -n '/== services/,/== pairing/p' | head -30
adb exec-out screencap -p > "$out/screen.png" 2>/dev/null && echo "screenshot: $out/screen.png"

printf '{"issue":%s,"suites":"%s","phone":"present","fail":%s}\n' "$n" "$([ ${#fail[@]} = 0 ] && echo green || echo red)" \
  "$(printf '%s\n' "${fail[@]}" | jq -R . | jq -s 'map(select(length>0))')" > "$out/verify.json"
[ ${#fail[@]} = 0 ] && verdict "$n" green || verdict "$n" red "${fail[*]}"
