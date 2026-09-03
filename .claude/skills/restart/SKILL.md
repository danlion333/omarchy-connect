---
name: restart
description: Restart Omarchy Connect after a code change so the running desktop actually picks it up — the daemon, the bar panel, or both. Use whenever asked to restart, reload, or "підхопити зміни", and whenever a change under daemon/ or shell/ needs to be seen in the real desktop rather than in tests.
---

# Restarting Omarchy Connect after a change

Two halves of this project run as two separate long-lived processes, installed in
two different places, and neither restart touches the other. Restarting the wrong
one is the usual reason a freshly written feature is invisible in the bar panel.

| What changed | What to restart |
| --- | --- |
| `daemon/` | the systemd user service |
| `shell/` (`Panel.qml`, `Service.qml`, `Model.js`, `manifest.json`) | reinstall the plugin **and** restart the shell |
| both | both, daemon first |
| `app/` | nothing here — that is Metro / a real build, see the `adb-phone` skill |

## The daemon

It runs out of the checkout (`ExecStart` points straight at
`~/Projects/omarchy-connect/daemon/bin/omarchy-connect.js`), so there is nothing to
install — a restart is enough.

```bash
systemctl --user restart omarchy-connect && sleep 3
systemctl --user status omarchy-connect | head -20
```

Confirm it worked by the **Main PID changing**, not by the unit saying `active`:
`Restart=on-failure` means a unit that died and came back still reads active.
A healthy start prints the summary box and, within a second or two, a
`--> <phone> connected from <ip>` line as the phone redials.

Logs, when it does not come up:

```bash
journalctl --user -u omarchy-connect -n 60 --no-pager
```

## The bar panel

The panel is **a copy**, not the checkout. `panel install` copies `shell/` into
`~/.config/omarchy/plugins/omarchy-connect.phone/`, so an edit in the repo changes
nothing on screen until it is copied over again.

```bash
node daemon/bin/omarchy-connect.js panel install
omarchy-restart-shell
```

Both commands are needed. `panel install` ends with a rescan, and the installer
itself says why that is not enough: *"a rescan will not replace a mounted widget"* —
Quickshell keeps the already-loaded QML until the whole shell process restarts.
Verify by the `quickshell -n -p /usr/share/omarchy/shell` PID changing.

To see whether the installed copy is stale before restarting anything:

```bash
for f in Panel.qml Model.js Service.qml manifest.json; do
  diff -q "shell/$f" ~/.config/omarchy/plugins/omarchy-connect.phone/$f
done
```

## When a panel feature is still missing after all that

The panel hides controls it believes do not apply, so check the condition against
live state before suspecting the restart. The state the QML reads is a file:

```bash
python3 -m json.tool ~/.local/state/omarchy-connect/status.json | head -60
```

`Service.qml` turns that file into the properties `Panel.qml` gates on — e.g. the
**Ring** button needs `canLocate`, which needs a device with `online: true` and
`via` other than `"remote"`. A phone that arrived down a tunnel legitimately gets
no Ring button.
