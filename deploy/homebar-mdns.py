#!/usr/bin/env python3
"""Announce a friendly name (default: homebar.local) for this machine in the home network.

Talks to the host's avahi-daemon over D-Bus, publishes NAME -> current LAN IPv4 of the default-route
interface and re-publishes when the IP changes. Run it as a systemd user service (see homebar-mdns.service).
"""

import os
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = os.environ.get("MDNS_NAME", "homebar.local")
CHECK_SECONDS = 30

AVAHI = "org.freedesktop.Avahi"
IF_UNSPEC = -1
PROTO_INET = 0
PUBLISH_NO_REVERSE = 16  # keep reverse lookups pointing at the real hostname


def lan_ip():
    """IPv4 of the interface that holds the default route (ignores VPN tunnels without a default route)."""
    try:
        route = subprocess.run(["ip", "route", "show", "default"], capture_output=True, text=True).stdout.split()
        dev = route[route.index("dev") + 1]
        addr = subprocess.run(["ip", "-4", "-o", "addr", "show", "dev", dev], capture_output=True, text=True).stdout
        return addr.split()[3].split("/")[0]
    except (ValueError, IndexError, OSError):
        return None


class Publisher:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM)
        self.group = None
        self.ip = None

    def call(self, path, iface, method, args=None, reply=None):
        return self.bus.call_sync(AVAHI, path, iface, method, args,
                                  GLib.VariantType(reply) if reply else None,
                                  Gio.DBusCallFlags.NONE, -1, None)

    def publish(self, ip):
        if self.group is None:
            (self.group,) = self.call("/", f"{AVAHI}.Server", "EntryGroupNew", reply="(o)").unpack()
        else:
            self.call(self.group, f"{AVAHI}.EntryGroup", "Reset")
        self.call(self.group, f"{AVAHI}.EntryGroup", "AddAddress",
                  GLib.Variant("(iiuss)", (IF_UNSPEC, PROTO_INET, PUBLISH_NO_REVERSE, NAME, ip)))
        self.call(self.group, f"{AVAHI}.EntryGroup", "Commit")
        self.ip = ip
        print(f"published {NAME} -> {ip}", flush=True)

    def tick(self):
        ip = lan_ip()
        if ip and ip != self.ip:
            try:
                self.publish(ip)
            except GLib.Error as e:
                # avahi restarted or name collision: start over with a fresh group on the next tick
                print(f"publish failed: {e.message}", file=sys.stderr, flush=True)
                self.group, self.ip = None, None
        return True


def main():
    pub = Publisher()
    pub.tick()
    GLib.timeout_add_seconds(CHECK_SECONDS, pub.tick)
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
