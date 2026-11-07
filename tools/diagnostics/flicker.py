#!/usr/bin/env python3
"""閃爍協議：4Hz Page.captureScreenshot 迴圈，偵測空白幀。

用法：python3 flicker.py <ws-url> <seconds> <outdir>
以 --remote-debugging-port=9223 啟動 app 後：
  WS=$(curl -s http://127.0.0.1:9223/json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")

空白幀定義：畫面上方 70%（貓本體區域，避開底部 DOM 狀態列）非透明像素 < 0.5%。
preserveDrawingBuffer:false 時若合成器取到失效緩衝區，該區域會全透明。
純標準庫 WebSocket client（Node 18 無全域 WebSocket、環境無 ws/websocket-client）。
"""
import base64
import io
import json
import os
import socket
import struct
import sys
import time
from urllib.parse import urlparse

from PIL import Image


class WS:
    def __init__(self, url):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port or 80}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        assert b"101" in resp.split(b"\r\n")[0], resp[:200]
        self.buf = resp.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("ws closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        chunks = []
        while True:
            b1, b2 = self._read(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                mask = self._read(4)
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(n)))
            else:
                data = self._read(n)
            if opcode == 0x8:
                raise ConnectionError("ws close frame")
            if opcode in (0x1, 0x2, 0x0):
                chunks.append(data)
            if fin:
                return b"".join(chunks)


def blank_ratio(png_bytes):
    im = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    w, h = im.size
    top = im.crop((0, 0, w, int(h * 0.7)))
    alpha = top.getchannel("A")
    hist = alpha.histogram()
    nonzero = sum(hist[1:])
    return nonzero / (w * int(h * 0.7))


def main():
    ws_url, seconds, outdir = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    ws = WS(ws_url)
    blanks = 0
    total = 0
    ratios = []
    t_end = time.time() + seconds
    i = 0
    while time.time() < t_end:
        t0 = time.time()
        ws.send(json.dumps({"id": i, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == i:
                break
        total += 1
        if "error" in m:
            print("ERR", m["error"])
            break
        png = base64.b64decode(m["result"]["data"])
        r = blank_ratio(png)
        ratios.append(r)
        if r < 0.005:
            blanks += 1
            with open(os.path.join(outdir, f"blank-{i:04d}.png"), "wb") as f:
                f.write(png)
        if i % 40 == 0:
            with open(os.path.join(outdir, f"frame-{i:04d}.png"), "wb") as f:
                f.write(png)
        i += 1
        wait = 0.25 - (time.time() - t0)
        if wait > 0:
            time.sleep(wait)
    ratios.sort()
    med = ratios[len(ratios) // 2] if ratios else -1
    print(f"frames={total} blanks={blanks} median_nontransparent_ratio={med:.3f}")
    print("BLANK_FAIL" if blanks else "BLANK_PASS")


if __name__ == "__main__":
    main()