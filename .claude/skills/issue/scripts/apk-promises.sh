#!/usr/bin/env bash
# Does the APK that was just built actually carry what app.json promises?
#
# `app.json` is not the manifest; it is the source Expo generates the manifest
# from. Editing it and running `gradlew assembleRelease` builds whatever
# AndroidManifest.xml happened to be lying in android/ from the last prebuild,
# with no error and no warning. Issue #15 shipped that way: three SEND
# intent-filters declared in app.json, a release APK installed on the phone, a
# green verification, a closed issue — and an app that was never in the share
# sheet, because the manifest in the APK was four days old.
#
# So this reads the manifest out of the built APK and holds it against what
# app.json declares. Usage:
#
#   apk-promises.sh <worktree> <apk>
#
# Silent and exit 0 when every declaration made it in; prints the missing ones
# and exits 1 when they did not.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
wt="${1:?worktree}"; apk="${2:?apk}"
cfg="$wt/app/app.json"

[ -f "$apk" ] || die "no APK at $apk"
[ -f "$cfg" ] || die "no app.json at $cfg"

aapt2="$(ls -d "$HOME"/Android/Sdk/build-tools/*/ 2>/dev/null | sort -V | tail -1)aapt2"
# A check that quietly skips itself is the bug it is meant to catch, so a
# missing aapt2 is a failure, not a shrug.
[ -x "$aapt2" ] || die "aapt2 not found under ~/Android/Sdk/build-tools — cannot read the APK's manifest"

manifest="$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk" 2>/dev/null)"
[ -n "$manifest" ] || die "aapt2 could not read a manifest out of $apk"

# What app.json says the app is. Actions may be written short ("SEND") or fully
# qualified; the manifest always holds the long form.
promises="$(node -e '
  const cfg = require(process.argv[1]).expo ?? {}
  const a = cfg.android ?? {}
  const want = []
  want.push(["package", a.package].join("\t"))
  for (const f of a.intentFilters ?? []) {
    const action = f.action?.includes(".") ? f.action : `android.intent.action.${f.action}`
    want.push(["action", action].join("\t"))
    for (const c of f.category ?? []) {
      want.push(["category", c.includes(".") ? c : `android.intent.category.${c}`].join("\t"))
    }
  }
  for (const p of a.permissions ?? []) want.push(["permission", p].join("\t"))
  console.log(want.filter(l => !l.endsWith("\tundefined")).join("\n"))
' "$cfg")"

missing=()
while IFS=$'\t' read -r kind value; do
  [ -n "$value" ] || continue
  # Every one of these lands in the manifest as a quoted string literal, so a
  # fixed-string search for it is enough and cannot be fooled by a prefix:
  # "android.permission.READ_SMS" never matches READ_SMS_FOO.
  grep -qF "\"$value\"" <<<"$manifest" || missing+=("$kind $value")
done <<<"$promises"

if [ ${#missing[@]} -gt 0 ]; then
  echo "the built APK does not carry what app.json declares:"
  printf '  missing: %s\n' "${missing[@]}"
  echo
  echo "app.json was edited but the native project was not regenerated from it."
  echo "Run 'npx expo prebuild --platform android' in the worktree's app/, then"
  echo "rebuild. Note that prebuild deletes android/local.properties; without it"
  echo "gradle falls back to ANDROID_HOME=/opt/android-sdk, which does not exist."
  exit 1
fi

echo "APK manifest carries every app.json declaration ($(grep -c . <<<"$promises") checked)"
