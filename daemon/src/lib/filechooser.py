#!/usr/bin/env python3
"""One file dialog, and the connection that has to stay open to hear its answer.

The desktop client has no file dialog of its own, so browsing for a file to
send happens in the one everything else here opens: the chooser behind the XDG
desktop portal, drawn by whatever backend the session has.

This is a program rather than two `gdbus` calls because of how the portal
answers. `OpenFile` returns a request object immediately and the file arrives
later, as a `Response` signal addressed to the connection that asked — and to
nothing else. A shell that calls and exits has already dropped that connection
by the time somebody picks a file, so the answer goes to a name that is gone.
Holding the connection open is the whole job, and glib's bindings are the
shortest way to do it on a desktop that already has them.

Exit codes are the interface: 0 with a path on stdout, 1 for a dialog that was
closed rather than answered, 2 for one that could not open at all.
"""

import sys
from urllib.parse import unquote, urlparse

try:
    import gi

    from gi.repository import Gio, GLib
except ImportError as err:
    print(f"{err} — python-gobject is missing", file=sys.stderr)
    sys.exit(2)

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"


def main():
    title = sys.argv[1] if len(sys.argv) > 1 else "Open"
    accept = sys.argv[2] if len(sys.argv) > 2 else ""

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    picked = []

    def answered(_bus, _sender, _path, _interface, _signal, params):
        _code, results = params.unpack()
        picked.extend(results.get("uris") or [])
        loop.quit()

    # No path filter: this connection makes exactly one request in its life, so
    # any Response on it is the answer to that one. Predicting the request path
    # from the handle token would work too, and would be one more thing to be
    # wrong about across portal versions.
    bus.signal_subscribe(
        PORTAL, "org.freedesktop.portal.Request", "Response", None, None, Gio.DBusSignalFlags.NONE, answered
    )

    options = {
        "handle_token": GLib.Variant("s", "omarchy_connect"),
        "multiple": GLib.Variant("b", False),
    }
    if accept:
        options["accept_label"] = GLib.Variant("s", accept)

    bus.call_sync(
        PORTAL,
        PORTAL_PATH,
        "org.freedesktop.portal.FileChooser",
        "OpenFile",
        GLib.Variant("(ssa{sv})", ("", title, options)),
        GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        -1,
        None,
    )

    # Nothing here gives up on its own: a dialog is open for as long as somebody
    # is looking at it, and killing this process is what closes it — the portal
    # cancels a request whose caller went away.
    loop.run()

    if not picked:
        return 1
    # A URI, so a space arrives as %20 and has to be put back.
    print(unquote(urlparse(picked[0]).path))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GLib.Error as err:
        print(err.message, file=sys.stderr)
        sys.exit(2)
