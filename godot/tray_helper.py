#!/usr/bin/env python3
"""AuraPet tray helper for the Godot body (Linux).

Godot 4.7's DisplayServer implements status indicators on Windows/macOS only
(platform/{windows,macos} have create_status_indicator; linuxbsd/X11 does not),
so the body spawns this small Ayatana AppIndicator process on Linux. It speaks
the same bridge protocol as a `ui` client: tray actions become normal
ui>brain requests/events, and the brain relays them to the body.

Deps: python3-gi, gir1.2-ayatanaappindicator3-0.1 (both present on Cinnamon).
No third-party Python packages: the WebSocket client below is stdlib-only.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import threading
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
from gi.repository import GLib, Gtk  # noqa: E402


class BridgeClient(threading.Thread):
    def __init__(self, port, token, on_event, on_ready):
        super().__init__(daemon=True)
        self.port = port
        self.token = token
        self.on_event = on_event
        self.on_ready = on_ready
        self.sock = None
        self.lock = threading.Lock()
        self.next_id = 1

    def send(self, message):
        payload = json.dumps({"v": 1, **message}).encode()
        with self.lock:
            if self.sock is None:
                return
            self._send_frame(0x1, payload)

    def request(self, t, payload=None):
        self.next_id += 1
        self.send({"id": self.next_id, "t": t, **(payload or {})})

    def _send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + body)

    def _recv_exact(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("socket closed")
            data += chunk
        return data

    def _read_frame(self):
        b1, b2 = self._recv_exact(2)
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed")
            header += chunk
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise ConnectionError("upgrade rejected")

    def run(self):
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                self.sock.settimeout(None)
                self._handshake()
                self.next_id += 1
                self.send({"id": self.next_id, "t": "hello", "role": "ui",
                           "name": "aurapet-tray", "version": "0.1.0",
                           "protocol": 1, "token": self.token})
                GLib.idle_add(self.on_ready)
                while True:
                    opcode, payload = self._read_frame()
                    if opcode == 0x8:
                        raise ConnectionError("server closed")
                    if opcode == 0x9:
                        with self.lock:
                            self._send_frame(0xA, payload)
                        continue
                    if opcode != 0x1:
                        continue
                    try:
                        message = json.loads(payload.decode())
                    except ValueError:
                        continue
                    if "t" in message:
                        GLib.idle_add(self.on_event, message)
            except (OSError, ConnectionError) as err:
                with self.lock:
                    try:
                        if self.sock:
                            self.sock.close()
                    except OSError:
                        pass
                    self.sock = None
                print(f"tray-helper: disconnected: {err}", flush=True)
                time.sleep(2)


class TrayApp:
    def __init__(self, args):
        self.args = args
        self.bridge = BridgeClient(args.port, args.token, self.on_event, self.on_ready)
        self.updating = False
        self.mode = "pet"
        self.visible = True
        self.roam = False
        self.always = True

        self.indicator = AppIndicator.Indicator.new(
            "aurapet-body", args.icon or "applications-games",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.indicator.set_title("AuraPet")
        if args.icon and os.path.exists(args.icon):
            self.indicator.set_icon_full(args.icon, "AuraPet")

        menu = Gtk.Menu()
        self.menu = menu
        item = Gtk.MenuItem(label="AuraPet 桌面寵物")
        item.set_sensitive(False)
        menu.append(item)
        menu.append(Gtk.SeparatorMenuItem())
        item = Gtk.MenuItem(label="切換寵物/對話形態")
        item.connect("activate", lambda _i: self.bridge.send({"t": "mode.toggle"}))
        menu.append(item)
        self.visible_item = self._check("顯示 / 隱藏", not self.visible, self.toggle_visible)
        self.always_item = self._check("置頂顯示", self.always, self.toggle_always)
        self.roam_item = self._check("到處走 (螢幕邊緣)", self.roam, self.toggle_roam)
        menu.append(Gtk.SeparatorMenuItem())
        item = Gtk.MenuItem(label="撫摸寵物")
        item.connect("activate", lambda _i: self.bridge.send(
            {"t": "interaction", "kind": "pat", "source": "tray"}))
        menu.append(item)
        item = Gtk.MenuItem(label="餵食美味小點心")
        item.connect("activate", lambda _i: self.bridge.send(
            {"t": "interaction", "kind": "feed", "source": "tray"}))
        menu.append(item)
        menu.append(Gtk.SeparatorMenuItem())
        item = Gtk.MenuItem(label="徹底退出 AuraPet (結束後台)")
        item.connect("activate", lambda _i: self.bridge.send({"t": "window.close"}))
        menu.append(item)
        menu.show_all()
        self.indicator.set_menu(menu)

    def _check(self, label, active, callback):
        item = Gtk.CheckMenuItem(label=label)
        item.set_active(active)
        item.connect("toggled", callback)
        self.menu.append(item)
        return item

    def _set_checks(self):
        self.updating = True
        self.visible_item.set_active(not self.visible)
        self.always_item.set_active(self.always)
        self.roam_item.set_active(self.roam)
        self.updating = False

    def toggle_visible(self, item):
        if self.updating:
            return
        self.bridge.request("window.set", {"visible": not self.visible})

    def toggle_always(self, item):
        if self.updating:
            return
        self.bridge.request("window.set", {"alwaysOnTop": item.get_active()})

    def toggle_roam(self, item):
        if self.updating:
            return
        self.bridge.send({"t": "roam.set-enabled", "enabled": item.get_active()})

    def on_ready(self):
        print("tray-helper: connected", flush=True)
        return False

    def on_event(self, message):
        t = message.get("t")
        if t == "state.sync":
            if message.get("mode") in ("pet", "chat"):
                self.mode = message["mode"]
            if "roamEnabled" in message:
                self.roam = bool(message["roamEnabled"])
            if "visibility" in message:
                self.visible = bool(message["visibility"])
            if "alwaysOnTop" in message:
                self.always = bool(message["alwaysOnTop"])
            self._set_checks()
        elif t == "window.state":
            if "visible" in message:
                self.visible = bool(message["visible"])
            if "alwaysOnTop" in message:
                self.always = bool(message["alwaysOnTop"])
            self._set_checks()
        elif t == "roam.enabled":
            self.roam = bool(message.get("enabled"))
            self._set_checks()
        elif t == "mode.changed":
            self.mode = message.get("mode", self.mode)
        return False


def read_token(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)["bridgeToken"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=47821)
    parser.add_argument("--config", required=True)
    parser.add_argument("--icon", default="")
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    try:
        args.token = read_token(args.config)
    except (OSError, ValueError, KeyError) as err:
        print(f"tray-helper: cannot read token: {err}", flush=True)
        return 1
    app = TrayApp(args)
    app.bridge.start()
    if args.parent_pid > 0:
        def parent_alive():
            try:
                os.kill(args.parent_pid, 0)
                return True
            except OSError:
                Gtk.main_quit()
                return False
        GLib.timeout_add_seconds(2, parent_alive)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
