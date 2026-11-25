"""Run one Developer sandbox VM behind a private authenticated endpoint."""

import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import json
import re
import selectors
import ssl
import subprocess
import threading
import time
from urllib.request import Request, urlopen

NAMESPACE = os.environ["COWORK_SANDBOX_NAMESPACE"]
VM = os.environ["COWORK_SANDBOX_VM"]
TOKEN = os.environ["COWORK_SANDBOX_TOKEN"]
if not TOKEN:
    raise ValueError("A sandbox token is required")
LOCK = threading.Lock()
MAX_RESULT = 4 * 1024 * 1024


def kubectl(*args):
    return subprocess.check_output(
        ["kubectl", "-n", NAMESPACE, "--request-timeout=8s", *args],
        timeout=10, text=True,
    ).strip()


def lifecycle(action):
    path = f"/apis/subresources.kubevirt.io/v1/namespaces/{NAMESPACE}/virtualmachines/{VM}/{action}"
    kubectl("replace", "--raw", path, "-f", "/dev/null")


def forward(pod):
    process = subprocess.Popen(
        ["kubectl", "-n", NAMESPACE, "port-forward", "--address=127.0.0.1", pod, ":8765"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if selector.select(timeout=4):
                line = process.stdout.readline()
                match = re.search(rb"Forwarding from 127\.0\.0\.1:(\d+)", line)
                if match:
                    return process, f"http://127.0.0.1:{int(match[1])}"
        raise RuntimeError("Desktop forwarding failed")
    except Exception:
        stop_forward(process)
        raise


def stop_forward(process):
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def render(body):
    deadline = time.monotonic() + 52
    active = False
    try:
        while time.monotonic() < deadline:
            instance = kubectl("get", "vmi", VM, "--ignore-not-found", "-o", "json")
            if not instance:
                lifecycle("start")
                active = True
                break
            if not json.loads(instance)["metadata"].get("deletionTimestamp"):
                active = True
                break
            time.sleep(1)
        while time.monotonic() < deadline:
            pod = kubectl("get", "pods", "-l", f"vm.kubevirt.io/name={VM}",
                          "--field-selector=status.phase=Running",
                          "-o", "jsonpath={.items[*].metadata.name}")
            if pod and " " not in pod:
                try:
                    process, endpoint = forward(pod)
                except RuntimeError:
                    time.sleep(1)
                    continue
                try:
                    with urlopen(endpoint + "/health", timeout=2):
                        pass
                except OSError:
                    stop_forward(process)
                else:
                    try:
                        request = Request(endpoint + "/render", data=body,
                                          headers={"Content-Type": "application/json"})
                        with urlopen(request, timeout=26) as response:
                            result = response.read(MAX_RESULT + 1)
                        if len(result) > MAX_RESULT:
                            raise RuntimeError("Desktop result exceeded the limit")
                        return result
                    finally:
                        stop_forward(process)
            time.sleep(1)
        raise RuntimeError("Desktop guest did not become ready")
    finally:
        if active:
            lifecycle("stop")


class Broker(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def do_POST(self):
        if self.path != "/render":
            self.send_error(404)
            return
        auth = self.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(auth, f"Bearer {TOKEN}".encode()):
            self.send_error(401)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32768:
                raise ValueError()
            body = self.rfile.read(size)
        except (ValueError, OSError):
            self.send_error(400)
            return
        if not LOCK.acquire(blocking=False):
            self.send_error(409, "Sandbox is busy")
            return
        try:
            response = render(body)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.log_error("%s", error)
            self.send_error(502, "Sandbox unavailable")
            return
        finally:
            LOCK.release()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


if __name__ == "__main__":
    cert = os.environ.get("COWORK_SANDBOX_TLS_CERT")
    server = ThreadingHTTPServer(("0.0.0.0" if cert else "127.0.0.1", 18766), Broker)
    if cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, os.environ["COWORK_SANDBOX_TLS_KEY"])
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
