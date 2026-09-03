---
name: issue-plan
description: Sort this repository's open GitHub issues into what the harness can finish alone, what needs a release APK on the phone, and what needs a person (a real call, a real SMS), label them, and write the order they will be done in to the /issue queue. Use once before `/loop /issue next`, and again whenever issues are added or the order should change.
---

# Planning the queue

The output is two things on GitHub and one file in the repo: a `harness:*` label
on every open issue, and `.claude/skills/issue/queue.txt` — one issue number per
line, in the order `/issue next` will take them. Commit the queue.

```bash
.claude/skills/issue/scripts/labels.sh
gh issue list --state open --limit 100 --json number,title,labels,body
```

## The three classes

Read each issue's **Acceptance criteria** and **Pointers** and ask one question:
*can every criterion be observed over adb and against the daemon, without a
second phone?*

- **`harness:auto`** — yes, and the phone side is only "the link is still up":
  daemon fixes, protocol fixes, shell changes, tests. Verified by the suites and
  the daemon running from the worktree with the phone redialling into it.
- **`harness:apk`** — yes, but the JS or native app changed, so a release APK
  has to be built and installed, and the criteria are exercised with `am start`,
  `input`, `screencap`, `logcat`. Share-sheet, clipboard, file-drop features.
- **`harness:human`** — at least one criterion needs a real incoming call or SMS,
  a second device, or a judgment about how something feels. The harness still
  implements, tests and merges it, and leaves the issue open with a checklist.
  `adb` cannot fake `SMS_RECEIVED` or a call on a real device; do not classify
  something `auto` on the hope that it can.

`gh issue edit <n> --add-label harness:<class>`; remove a wrong one with
`--remove-label`.

## The order

Write `queue.txt` by these rules, in this precedence:

1. **Foundations first.** Anything that changes the protocol, the transport, or
   the security model (frame validation, TLS, tokens, auth) goes before features
   that would build on it, so features are written once.
2. **`auto`, then `apk`, then `human`.** The human class last, all together, so
   the user's manual checks happen in one sitting at the end rather than
   interrupting the run four times.
3. **Small before large within a class** — a quick calibration of the contract
   before anything long.
4. A blocked issue keeps its place; `next.sh` skips it by label, not by order.

Comment lines (`# …`) are allowed in the queue for the reasoning; `next.sh`
ignores anything that is not a bare number.

Finish by saying, in three short lists, what is in each class and why anything
went to `human`.
