---
name: issue
description: Do one GitHub issue of this repository end to end with nobody watching — worktree from fresh master, implement, run the suites, prove it on the real phone over adb with the daemon running from the worktree, then merge to master and close the issue. Use as `/issue <number>` for one issue, `/issue next` for the first unblocked one in the queue, or under `/loop /issue next` to work through the whole queue. Requires `/issue-plan` to have labelled and queued the issues first.
---

# One issue, start to finish

**You are the dispatcher, not the worker.** Doing an issue means reading its
code, its diffs, its suite output and its logcat — a hundred thousand tokens for
one issue, and ten issues in one context means a model that has forgotten the
first four by the time it reaches the fifth. So you hand each issue to a
subagent with a context of its own, and keep only the line it comes back with.

Do not read the issue body, open the worktree, or run the scripts below
yourself. `worker.md` is not for you; it is the instruction sheet you point the
subagent at.

## The dispatch

```bash
n=$(.claude/skills/issue/scripts/next.sh)   # or the number the user gave
```

`next.sh` exits non-zero when nothing is left that is open, planned and
unblocked. That is the end of the queue, not an error.

With a number in hand, spawn **one** subagent — `general-purpose`, and only one
at a time, because the phone, the daemon and the bar panel exist once:

> Read `.claude/skills/issue/worker.md` and do issue #`<n>` of this repository
> exactly as it says, end to end. You have the phone and the daemon to yourself.
> Report back in the shape the file's last section describes — at most ten
> lines, no diffs and no test output.

Wait for it. Then take its `VERDICT` line — the same line is in
`~/.local/state/omarchy-connect/harness/<n>/RESULT` if the agent came back
without one — and tell the user, in two or three lines, what happened to that
issue. Keep a running tally across the session; it is all you need to carry.

The verdicts are `merged`, `handover` (a `harness:human` issue, merged but left
open with its checklist), `blocked <why>`, `phone-missing`, and `red <why>` if
the subagent gave up mid-verification.

Do not re-verify, re-read or second-guess a subagent's work. If a verdict looks
wrong, send the same agent a message asking about it rather than opening the
worktree here.

## Under /loop

`/loop /issue next` runs this until the queue is empty. One tick, one issue.

- `merged`, `handover`, `blocked` — `noop: false`, short delay; the queue moved.
- `phone-missing` — `noop: true`, long delay (1800s+). The first time, send a
  `PushNotification` so the user knows the cable is all that is missing.
- `red` — `noop: false`, short delay. The next tick gets the same issue again,
  which is what a second attempt should look like. After a third `red` on one
  number, ask the subagent to `block.sh` it rather than looping on it forever.
- `next.sh` empty — end the loop with a summary: what was merged, what waits on
  `harness:verify`, what is blocked and why.

## Doing one here instead

`/issue <n> --here` skips the subagent and follows `worker.md` in this context.
Use it only when the user is watching and wants to see the work — debugging the
harness itself, or an issue they want to steer. For anything unattended, and
always under `/loop`, dispatch.
