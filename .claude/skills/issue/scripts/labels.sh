#!/usr/bin/env bash
# Make sure the harness labels exist. Idempotent; safe to run every time.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mk() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "label $1"; }
mk harness:auto    1d76db "Harness does it end to end: tests + daemon smoke on the phone"
mk harness:apk     0e8a16 "Harness does it end to end, including a release APK on the phone"
mk harness:human   fbca04 "Harness implements and merges; a person verifies from the checklist"
mk harness:blocked b60205 "Harness tried and could not finish; see the last comment"
mk harness:verify  c5def5 "Merged; waiting for the manual checks in the last comment"
