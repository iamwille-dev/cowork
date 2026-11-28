"""Render Cowork pilot previews in the guest's persistent Chromium profile."""

import base64
import html
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILE = Path.home() / ".cowork-chromium"
LOCK = threading.Lock()
MAX_REQUEST = 2 * 1024 * 1024
MAX_HTML = 256 * 1024


def render(page):
    loaded = threading.Event()

    class Preview(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/preview.html":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy",
                             "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            self.end_headers()
            self.wfile.write(page)
            loaded.set()

    with tempfile.TemporaryDirectory() as directory, ThreadingHTTPServer(("127.0.0.1", 0), Preview) as preview:
        screenshot = Path(directory) / "screenshot.png"
        threading.Thread(target=preview.serve_forever, daemon=True).start()
        try:
            browser = subprocess.Popen(
                ["chromium", "--kiosk", "--no-first-run", "--disable-background-networking",
                 f"--user-data-dir={PROFILE}", f"http://127.0.0.1:{preview.server_port}/preview.html"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
            try:
                if not loaded.wait(timeout=8):
                    raise TimeoutError("Chromium did not load the preview page")
                subprocess.run(
                    ["xdotool", "search", "--sync", "--onlyvisible", "--class", "chromium"],
                    check=True, timeout=20, stdout=subprocess.DEVNULL,
                )
                time.sleep(0.5)
                subprocess.run(["scrot", str(screenshot)], check=True, timeout=8)
                return {"screenshot": base64.b64encode(screenshot.read_bytes()).decode()}
            finally:
                try:
                    os.killpg(browser.pid, signal.SIGTERM)
                    browser.wait(timeout=5)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(browser.pid, signal.SIGKILL)
                    browser.wait()
        finally:
            preview.shutdown()


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
            if not 0 < length <= MAX_REQUEST:
                raise ValueError()
            task = json.loads(self.rfile.read(length))
            if not isinstance(task, dict):
                raise ValueError()
            legacy = "html" not in task
            if legacy:
                title, brief = task["title"], task["brief"]
                if not isinstance(title, str) or not 0 < len(title) <= 120:
                    raise ValueError()
                if not isinstance(brief, str) or not 0 < len(brief) <= 6000:
                    raise ValueError()
                markup = (
                    '<!doctype html><html lang="en"><meta charset="utf-8">'
                    f"<title>{html.escape(title)}</title>"
                    '<style>body{margin:8vw;background:#f1efe8;color:#171f1a;'
                    'font:22px system-ui}h1{font-size:64px}p{white-space:pre-wrap}</style>'
                    f"<main><h1>{html.escape(title)}</h1><p>{html.escape(brief)}</p></main>"
                )
            else:
                markup = task["html"]
            if not isinstance(markup, str):
                raise ValueError()
            page = markup.encode("utf-8")
            if not 0 < len(page) <= MAX_HTML:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            self.send_error(400)
            return
        with LOCK:
            try:
                result = render(page)
                if legacy:
                    result["html"] = markup
                body = json.dumps(result).encode()
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
