import os
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from agento_brain.backends import RulesBackend
from agento_brain.server import AlreadyRunning, prepare_unix_socket, write_pid_file
from agento_brain.service import Service
from conftest import Client, start_server


def test_unix_roundtrip_perms_and_cleanup(short_tmp):
    p = short_tmp / "x.sock"
    srv, _ = start_server(Service(RulesBackend()), p)
    try:
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
        s, b = Client(str(p)).post("/v1/route", {"text": "rename foo to bar"})
        assert s == 200 and b["tier"] == "sonnet"
    finally:
        srv.shutdown(); srv.server_close()


def test_stale_socket_is_cleaned(short_tmp):
    p = short_tmp / "stale.sock"
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(p)); s.close()  # leaves a socket file nobody listens on
    assert p.exists()
    prepare_unix_socket(p)
    assert not p.exists()


def test_live_socket_is_not_stolen(short_tmp):
    p = short_tmp / "live.sock"
    srv, _ = start_server(Service(RulesBackend()), p)
    try:
        with pytest.raises(AlreadyRunning):
            prepare_unix_socket(p)
    finally:
        srv.shutdown(); srv.server_close()


def test_refuses_to_remove_non_socket(short_tmp):
    p = short_tmp / "file.sock"
    p.write_text("precious")
    with pytest.raises(RuntimeError, match="not a socket"):
        prepare_unix_socket(p)
    assert p.read_text() == "precious"


def test_long_socket_path_rejected(tmp_path):
    with pytest.raises(ValueError, match="too long"):
        prepare_unix_socket(tmp_path / ("a" * 120) / "b.sock")


def test_pid_file(short_tmp):
    p = short_tmp / "b.pid"
    write_pid_file(p)
    assert int(p.read_text()) == os.getpid() and stat.S_IMODE(os.stat(p).st_mode) == 0o600
    write_pid_file(p)  # own pid: fine
    p.write_text(str(os.getppid()))  # a live process that is not us
    with pytest.raises(AlreadyRunning):
        write_pid_file(p)
    p.write_text("999999999")  # dead pid: stale, overwritten
    write_pid_file(p)


def test_sigterm_graceful_shutdown_subprocess(short_tmp):
    sock, pid = short_tmp / "d.sock", short_tmp / "d.pid"
    env = {**os.environ, "AGENTO_HOME": str(short_tmp / "home")}
    proc = subprocess.Popen(
        [sys.executable, "-m", "agento_brain.cli", "serve", "--socket", str(sock), "--pid-file", str(pid)],
        env=env, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(100):
            if sock.exists():
                break
            time.sleep(0.05)
        else:
            pytest.fail("server did not start: " + proc.stderr.read())
        s, h = Client(str(sock)).get("/healthz")
        assert h["model_run_id"] == "rules-v1"
        assert int(pid.read_text()) == proc.pid
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 0
        assert not sock.exists() and not pid.exists()
    finally:
        if proc.poll() is None:
            proc.kill()


def test_serve_fails_loudly_on_bad_model_dir(short_tmp):
    r = subprocess.run(
        [sys.executable, "-m", "agento_brain.cli", "serve", "--socket", str(short_tmp / "e.sock"), "--model-dir", str(short_tmp / "missing"), "--no-pid-file"],
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 2 and "model contract violated" in r.stderr


def test_default_to_rules_without_model_dir(short_tmp, monkeypatch):
    from agento_brain.cli import _build_service

    monkeypatch.setenv("AGENTO_HOME", str(short_tmp))
    monkeypatch.delenv("AGENTO_BRAIN_MODEL_DIR", raising=False)
    assert _build_service(None, False).backend.run_id == "rules-v1"


def test_default_model_dir_is_picked_up(short_tmp, monkeypatch, model_dir):
    import shutil
    from agento_brain.cli import _build_service

    monkeypatch.setenv("AGENTO_HOME", str(short_tmp))
    shutil.copytree(model_dir, short_tmp / "brain" / "model")
    assert _build_service(None, False).backend.run_id == "test-run-1"
    assert _build_service(None, True).backend.run_id == "rules-v1"  # --rules wins


def test_tcp_port_mode(model_dir):
    import http.client, json, threading
    from agento_brain.server import make_server

    srv = make_server(Service(RulesBackend()), port=0)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1])
        c.request("GET", "/healthz")
        assert json.loads(c.getresponse().read())["ok"] is True
    finally:
        srv.shutdown(); srv.server_close()
