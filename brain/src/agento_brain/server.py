"""Stdlib HTTP server over a unix socket (default) or loopback TCP. No framework."""

from __future__ import annotations

import errno
import json
import os
import signal
import socket
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

from .service import ApiError, Service

MAX_BODY = 1 << 20  # 1 MiB
UNIX_PATH_MAX = 100  # macOS limit is 104 (sun_path), Linux 108


class AlreadyRunning(RuntimeError):
    pass


def make_handler(service: Service) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "agento-brain"

        def log_message(self, fmt: str, *args) -> None:  # quiet by default; unix peers have no (host, port)
            if os.environ.get("AGENTO_BRAIN_LOG"):
                sys.stderr.write("agento-brain: " + fmt % args + "\n")

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _read_json(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise ApiError(400, "bad_request", "invalid Content-Length") from None
            if n <= 0:
                raise ApiError(400, "bad_request", "empty body: expected a JSON object")
            if n > MAX_BODY:
                self.close_connection = True
                raise ApiError(413, "too_large", f"body exceeds {MAX_BODY} bytes")
            raw = self.rfile.read(n)
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                raise ApiError(400, "bad_json", f"invalid JSON: {e}") from None

        def _dispatch(self, method: str) -> None:
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            try:
                if method == "GET" and path == "/healthz":
                    status, body = service.healthz()
                elif method == "POST" and path == "/v1/route":
                    status, body = service.route(self._read_json())
                elif method == "POST" and path == "/v1/systemone":
                    status, body = service.systemone(self._read_json())
                elif path in ("/healthz", "/v1/route", "/v1/systemone"):
                    raise ApiError(405, "method_not_allowed", f"{method} not allowed on {path}")
                else:
                    raise ApiError(404, "not_found", f"no such endpoint: {method} {path}")
            except ApiError as e:
                status, body = e.status, e.body()
            except Exception as e:  # never leak a traceback, never kill the thread silently
                status, body = 500, {"error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}}
            self._send(status, body)

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

    return Handler


class UnixHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True
    request_queue_size = 64

    def server_bind(self) -> None:
        # socketserver.TCPServer.server_bind would try getsockname()[:2]; do it by hand
        self.socket.bind(self.server_address)
        self.server_name = "unix"
        self.server_port = 0

    def get_request(self):
        conn, _ = self.socket.accept()
        return conn, ("unix", 0)


def prepare_unix_socket(path: Path) -> None:
    """Create the parent dir (0700 if new) and remove a STALE socket; refuse if a live daemon owns it."""
    if len(str(path)) > UNIX_PATH_MAX:
        raise ValueError(f"unix socket path too long ({len(str(path))} > {UNIX_PATH_MAX}): {path}; use --socket with a shorter path")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise RuntimeError(f"{path} exists and is not a socket; refusing to remove it")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(1.0)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError):
        os.unlink(path)  # stale: nobody is listening
        return
    except OSError as e:
        if e.errno in (errno.ECONNREFUSED, errno.ENOENT):
            os.unlink(path)
            return
        raise
    else:
        raise AlreadyRunning(f"another agento-brain is already listening on {path}")
    finally:
        probe.close()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def write_pid_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        old = int(path.read_text().strip())
        if old != os.getpid() and _pid_alive(old):
            raise AlreadyRunning(f"pid file {path} points to a running process ({old})")
    except (FileNotFoundError, ValueError):
        pass
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()) + "\n")
    os.replace(tmp, path)


def make_server(service: Service, *, socket_path: Path | None = None, port: int | None = None) -> HTTPServer:
    handler = make_handler(service)
    if socket_path is not None:
        prepare_unix_socket(socket_path)
        old = os.umask(0o177)  # socket is created 0600
        try:
            srv = UnixHTTPServer(str(socket_path), handler)
        finally:
            os.umask(old)
        os.chmod(socket_path, 0o600)
        return srv
    assert port is not None
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.daemon_threads = True
    return srv


def serve(service: Service, *, socket_path: Path | None, port: int | None, pid_file: Path | None) -> int:
    """Blocking. SIGTERM/SIGINT -> graceful shutdown; socket and pid file are removed on exit."""
    srv = make_server(service, socket_path=socket_path, port=port)
    if pid_file is not None:
        write_pid_file(pid_file)

    def stop(signum, _frame) -> None:
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    where = str(socket_path) if socket_path is not None else f"127.0.0.1:{srv.server_address[1]}"
    print(f"agento-brain: backend={service.backend.kind} run_id={service.backend.run_id} listening on {where}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever(poll_interval=0.2)
    finally:
        srv.server_close()
        if socket_path is not None:
            try:
                os.unlink(socket_path)
            except FileNotFoundError:
                pass
        if pid_file is not None:
            try:
                if int(pid_file.read_text().strip()) == os.getpid():
                    pid_file.unlink()
            except (FileNotFoundError, ValueError):
                pass
        print("agento-brain: stopped", file=sys.stderr, flush=True)
    return 0
