# Doing one issue

You are the worker for a single issue. Somebody — the dispatcher in `SKILL.md`,
or a person — gave you one number. Do that issue end to end and come back with a
handful of lines. This whole file is written for a context that exists only for
this one issue and is thrown away afterwards, which is why you can afford to
read code and diffs here that the dispatcher could never afford to hold.

The contract is fixed and the scripts hold the state, so a run that is
interrupted halfway can be picked up from `~/.local/state/omarchy-connect/harness/<n>/`
and the worktree. **Nothing is merged that was not seen working on the phone.**
`finish.sh` refuses without a green `verify.json` taken with the device present;
do not work around that check.

Three shared things exist once — the phone, the running daemon, the bar panel —
so one issue at a time. You have them to yourself for as long as you run. Never
start a second worktree's verification, and do not spawn a subagent of your own:
you *are* the subagent, and the phone cannot be shared.

## Steps

### 1. Pick and open

```bash
S=.claude/skills/issue/scripts
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
$S/verify.sh "$n" "$wt"    # the only line it prints: VERDICT green | red … | phone-missing
```

What it does, in order: the suites of every package the branch touches
(`tools/run-tests.mjs`, all of them, not stopping at the first failure); `tsc`
when `app/` changed; then with the phone on the cable, restarts the daemon
**from the worktree** (a systemd drop-in, `daemon-from.sh`), waits for the phone
to redial, builds and installs a release APK when the class is `apk`, and reads
the phone's logcat, service state and screen.

For an APK it also regenerates the native project when the branch touched
`app/app.json`, and then reads the manifest back out of the built APK and holds
it against what `app.json` declares (`apk-promises.sh`). Both exist because
`app.json` is the *source* the manifest is generated from: editing it and
running gradle builds against whatever the last prebuild left in `android/`,
with no error anywhere. Issue #15 shipped exactly that way — three intent
filters declared, a green verification, a closed issue, and an app that was
never in the share sheet. A green build says the code compiles, not that the
config reached the phone.

All of that output goes to `$STATE/<n>/verify.log`, not to you. When the verdict
is red, ask for the part that failed and read that:

```bash
$S/explain.sh "$n"             # just the sections verify.json complained about
$S/explain.sh "$n" daemon      # or one by name: suites typecheck daemon apk phone
```

Do not `cat` the whole log, and do not go trawling the journal by hand —
`explain.sh <n> daemon` already includes it. The log is long on purpose so that
you can read a little of it, not all of it.

`red` — fix and verify again.

`phone-missing` — the suites passed but there was no device. Do not merge. Check
the USB picture (`adb-phone` skill, "Getting the phone to appear"), and if the
phone is simply not plugged in, stop here and report exactly that: the branch is
ready, the cable is the only thing missing.

`green` — go on to the issue-specific exercise below before finishing. The
script proves the build runs and the link is up; it does not know what the issue
was about.

### 4. Exercise the acceptance criteria on the phone

For each criterion, do the thing, on the device or against the worktree daemon,
and note what was observed. A criterion is met when the phone or the desktop
shows it, never because the code reads as if it would: the suites and the
typecheck have already agreed the code is right, and they were just as green on
the day #15 was closed unworking.

Prefer evidence that cannot be faked by the harness itself — the file's `sha256`
on both sides, the desktop clipboard actually changing, the resolver naming the
activity — over a screenshot of a screen that says it worked.

Beware that `am start` runs as shell, which cannot pass a `content://` read
grant to the app: a `SEND` fired that way arrives with an unreadable stream and
proves nothing about a real share. For anything that receives a file from
another app, drive a real one (the file manager's own share sheet) with
`input tap`, and confirm the intent-filter side separately with
`cmd package query-activities`.

The `adb-phone` skill has the recipes: `input`/`screencap` for UI,
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
$S/finish.sh "$n" "$wt" "$summary_file"   # prints VERDICT merged | handover
```

Merges `--no-ff` into master, pushes, puts the daemon back on master (and the
panel, when `shell/` changed), closes the issue — or for `harness:human`, leaves
it open with `harness:verify` and the comment — and removes the worktree.

### When it cannot be finished

After two honest attempts at a red verification, or when the issue turns out to
need a decision only the user can make (a protocol change it says is out of
scope, a trade-off the criteria do not settle):

```bash
$S/block.sh "$n" "$reason_file"           # prints VERDICT blocked <first line>
```

The first line of the reason file is the sentence the dispatcher and the user
will see, so make it the one that matters. Below it, say what was tried, what
failed, and what a person needs to decide. The worktree is kept.

## What to report back

Your caller has none of your context and wants none of it. Report **at most ten
lines**, in this shape, and nothing else — no diffs, no test output, no file
listings:

```
VERDICT <the exact line the last script printed>
issue: #<n> <title> (<class>)
did: <one or two sentences on what changed>
observed: <one line per acceptance criterion, or "see the issue comment">
needs a person: <only when there is something, otherwise omit>
```

For `blocked` or `phone-missing`, the point of the report is the reason: say in
one sentence what a person has to do about it.
