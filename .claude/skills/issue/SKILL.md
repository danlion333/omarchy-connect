---
name: issue
description: Do one GitHub issue of this repository end to end with nobody watching — worktree from fresh master, implement, run the suites, prove it on the real phone over adb with the daemon running from the worktree, then merge to master and close the issue. Use as `/issue <number>` for one issue, `/issue next` for the first unblocked one in the queue, or under `/loop /issue next` to work through the whole queue. Requires `/issue-plan` to have labelled and queued the issues first.
---

# One issue, start to finish

The contract is fixed and the scripts hold the state, so a run that is interrupted
halfway can be picked up from `~/.local/state/omarchy-connect/harness/<n>/` and the
worktree. **Nothing is merged that was not seen working on the phone.** `finish.sh`
refuses without a green `verify.json` taken with the device present; do not work
around that check.

Three shared things exist once — the phone, the running daemon, the bar panel — so
one issue at a time. Never start a second worktree's verification while another
is still pointed at the daemon.

## Steps

### 1. Pick and open

```bash
S=.claude/skills/issue/scripts
n=$($S/next.sh)            # or the number the user gave
$S/start.sh "$n"           # prints the issue and, last line, the worktree path
```

`start.sh` pulls master, adds `.claude/worktrees/issue-<n>` on branch `issue-<n>`,
links `node_modules`, and for `harness:apk` copies the untracked native project.
Read the printed issue: **What / Why / Pointers / Acceptance criteria / Out of
scope**. The acceptance criteria are the spec; the pointers say where; out of
scope is a fence, not a suggestion.

### 2. Implement, in the worktree only

Work from the worktree path, never from the main checkout. Every file path in
the issue is relative to the worktree. Follow the shape of the code around you
and the voice of the existing comments (they explain *why*, at length, in
English).

Add or extend a suite for the acceptance criteria that a test can express.
Suites live in `daemon/test/*.mjs` and `app/test/*.mjs` and import `check`/`done`
from `tools/test-harness.mjs`. A criterion like "the daemon survives a bad
request" is a test that sends the bad request to a spawned daemon and then sends
a good one. Register a new suite in `daemon/package.json`'s `test` chain too.

If a change touches `docs/PROTOCOL.md` territory (a frame, a field, an endpoint),
update the doc in the same commit.

Commit on the branch as you go, with the same kind of message the log already
has: one sentence that says what changed and why, no prefix.

### 3. Verify

```bash
$S/verify.sh "$n" "$wt"    # last line: VERDICT green | red … | phone-missing
```

What it does, in order: the suites of every package the branch touches
(`tools/run-tests.mjs`, all of them, not stopping at the first failure); `tsc`
when `app/` changed; then with the phone on the cable, restarts the daemon
**from the worktree** (a systemd drop-in, `daemon-from.sh`), waits for the phone
to redial, builds and installs a release APK when the class is `apk`, and reads
the phone's logcat, service state and screen.

`red` — fix and verify again. Read `$STATE/<n>/tests.json` for which check, and
the worktree daemon's journal for the phone half:
`journalctl --user -u omarchy-connect -n 80 --no-pager`.

`phone-missing` — the suites passed but there was no device. Do not merge. Check
the USB picture (`adb-phone` skill, "Getting the phone to appear"), and if the
phone is simply not plugged in, stop here and tell the user exactly that: the
branch is ready, the cable is the only thing missing. Under `/loop`, that is a
`noop` wait, not a failure.

`green` — go on to the issue-specific exercise below before finishing. The
script proves the build runs and the link is up; it does not know what the issue
was about.

### 4. Exercise the acceptance criteria on the phone

For each criterion, do the thing, on the device or against the worktree daemon,
and note what was observed. The `adb-phone` skill has the recipes: `am start`
with a `SEND` intent for share-sheet issues, `input`/`screencap` for UI,
`logcat -s OmarchyLink:V OmarchyTelephony:V` for the native modules, `curl`
against `127.0.0.1:8765` (after `adb reverse`) or the daemon's own CLI for
protocol issues. A criterion that only a real incoming call or SMS can exercise
is **not** checked off — it goes to the checklist in step 5.

Restore whatever the exercise changed (battery, Wi-Fi, permissions, reverse).

### 5. Finish

Write the closing comment to a file — what changed, in a paragraph; then each
acceptance criterion with what was observed (a log line, a screenshot path
`state/harness/<n>/screen.png` is fine to mention but not to attach), or the
words **not exercised: needs a person to …** for the ones that need a call or a
message. For a `harness:human` issue that list *is* the deliverable: it becomes
the checklist the user works through later.

```bash
$S/finish.sh "$n" "$wt" "$summary_file"
```

Merges `--no-ff` into master, pushes, puts the daemon back on master (and the
panel, when `shell/` changed), closes the issue — or for `harness:human`, leaves
it open with `harness:verify` and the comment — and removes the worktree.

### When it cannot be finished

After two honest attempts at a red verification, or when the issue turns out to
need a decision only the user can make (a protocol change it says is out of
scope, a trade-off the criteria do not settle):

```bash
$S/block.sh "$n" "$reason_file"
```

Say in the file what was tried, what failed, and what a person needs to decide.
The worktree is kept. Then move on to `next.sh` — a blocked issue does not stop
the queue.

## Under /loop

`/loop /issue next` runs this until `next.sh` says the queue is empty. Each tick
is one issue. The scheduling rule: a finished or blocked issue is `noop: false`
and a short delay; `phone-missing` is `noop: true` and a long delay, with a
`PushNotification` the first time so the user knows to plug in the cable; an
empty queue ends the loop with a summary of what was merged, what is waiting on
`harness:verify`, and what is blocked.
