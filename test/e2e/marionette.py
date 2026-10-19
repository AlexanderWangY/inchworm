"""Minimal Marionette client (stdlib only) for driving Zotero in tests.

Wire format: each packet is "<length>:<json>". Commands are
[0, id, name, params]; responses are [1, id, error, result].
"""
import json
import socket
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, connect_timeout=90):
        deadline = time.time() + connect_timeout
        while True:
            try:
                self.sock = socket.create_connection((host, port), timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.sock.settimeout(300)
        self.buf = b""
        self.msg_id = 0
        self.hello = self._recv()

    def _recv(self):
        while b":" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MarionetteError("connection closed")
            self.buf += chunk
        length, rest = self.buf.split(b":", 1)
        length = int(length)
        while len(rest) < length:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MarionetteError("connection closed")
            rest += chunk
        data, self.buf = rest[:length], rest[length:]
        return json.loads(data)

    def send(self, name, params=None):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._recv()
            if isinstance(msg, list) and msg[0] == 1 and msg[1] == self.msg_id:
                if msg[2]:
                    raise MarionetteError(msg[2])
                return msg[3]

    def start_chrome_session(self, script_timeout_ms=180000, window_timeout=90):
        # Marionette's normal session start waits for Firefox's
        # "browser-delayed-startup-finished", which Zotero never sends.
        # Windowless sessions skip that; then attach to Zotero's main window.
        self.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"moz:windowless": True}}})
        self.send("Marionette:SetContext", {"value": "chrome"})
        self.send("WebDriver:SetTimeouts", {"script": script_timeout_ms})
        deadline = time.time() + window_timeout
        while True:
            handles = self.send("WebDriver:GetWindowHandles")
            handles = handles.get("value", handles) if isinstance(handles, dict) else handles
            for handle in handles or []:
                self.send("WebDriver:SwitchToWindow", {"handle": handle})
                href = self.js("return document.location.href")
                if href == "chrome://zotero/content/zoteroPane.xhtml":
                    return
            if time.time() > deadline:
                raise MarionetteError("Zotero main window not found")
            time.sleep(1)

    def js(self, script, *args):
        """Run a script in chrome context. The body is async, so it can use await."""
        wrapped = "return (async function () {\n" + script + "\n}).apply(this, arguments);"
        result = self.send("WebDriver:ExecuteScript", {"script": wrapped, "args": list(args)})
        return result.get("value") if isinstance(result, dict) else result

    def screenshot(self, path):
        import base64
        result = self.send("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        data = result.get("value") if isinstance(result, dict) else result
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path

    def quit(self):
        try:
            self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
