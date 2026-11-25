"""Render Cowork pilot previews in the guest's persistent Chromium profile."""

import base64
import html
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILE = Path.home() / ".cowork-chromium"
LOCK = threading.Lock()


def render(title, brief):
    page = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        f"<title>{html.escape(title)}</title>"
        '<style>body{margin:8vw;background:#f1efe8;color:#171f1a;'
        'font:22px system-ui}h1{font-size:64px}p{white-space:pre-wrap}</style>'
        f"<main><h1>{html.escape(title)}</h1><p>{html.escape(brief)}</p></main>"
    )
    with tempfile.TemporaryDirectory() as directory:
        preview = Path(directory) / "preview.html"
        screenshot = Path(directory) / "screenshot.png"
        preview.write_text(page, encoding="utf-8")
        browser = subprocess.Popen(
            ["chromium", "--kiosk", "--no-first-run", "--disable-background-networking",
             f"--user-data-dir={PROFILE}", preview.as_uri()],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            subprocess.run(
                ["xdotool", "search", "--sync", "--onlyvisible", "--name", re.escape(title)],
                check=True, timeout=20, stdout=subprocess.DEVNULL,
            )
            time.sleep(0.5)
            subprocess.run(["scrot", str(screenshot)], check=True, timeout=8)
            return {"html": page, "screenshot": base64.b64encode(screenshot.read_bytes()).decode()}
        finally:
            try:
                os.killpg(browser.pid, signal.SIGTERM)
                browser.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(browser.pid, signal.SIGKILL)
                browser.wait()


class Desktop(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(204 if self.path == "/health" else 404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/render":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32768:
                raise ValueError()
            task = json.loads(self.rfile.read(length))
            title, brief = task["title"], task["brief"]
            if not isinstance(title, str) or not 0 < len(title) <= 120:
                raise ValueError()
            if not isinstance(brief, str) or not 0 < len(brief) <= 6000:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            self.send_error(400)
            return
        with LOCK:
            try:
                body = json.dumps(render(title, brief)).encode()
            except (OSError, subprocess.SubprocessError):
                self.send_error(502, "Chromium render failed")
                return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8765), Desktop).serve_forever()
