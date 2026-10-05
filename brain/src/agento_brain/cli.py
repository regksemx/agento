from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import __version__
from .contract import ContractError
from .paths import default_model_dir, default_pid_file, default_socket


def _build_service(model_dir: Path | None, force_rules: bool):
    from .backends import OnnxBackend, RulesBackend
    from .service import Service

    if force_rules:
        return Service(RulesBackend())
    explicit = model_dir or (Path(os.environ["AGENTO_BRAIN_MODEL_DIR"]) if os.environ.get("AGENTO_BRAIN_MODEL_DIR") else None)
    if explicit is not None:
        return Service(OnnxBackend(explicit))  # explicitly configured -> fail loudly, never silently fall back
    default = default_model_dir()
    if (default / "heads.json").is_file():
        return Service(OnnxBackend(default))
    return Service(RulesBackend())


def cmd_serve(a: argparse.Namespace) -> int:
    from .server import AlreadyRunning, serve

    try:
        svc = _build_service(a.model_dir, a.rules)
    except ContractError as e:
        print(f"agento-brain: {e}", file=sys.stderr)
        return 2
    sock = None if a.port is not None else (a.socket or default_socket())
    pid = None if a.no_pid_file else (a.pid_file or (default_pid_file() if sock is not None else None))
    try:
        return serve(svc, socket_path=sock, port=a.port, pid_file=pid)
    except (AlreadyRunning, ValueError, RuntimeError, OSError) as e:
        print(f"agento-brain: {e}", file=sys.stderr)
        return 1


def cmd_install(a: argparse.Namespace) -> int:
    from .install import install

    res = install(model_dir=a.model_dir, source=a.source, skip_venv=a.skip_venv, unit_dir=a.unit_dir, platform=a.platform)
    print(f"venv:  {res.venv_dir}{'  (skipped)' if a.skip_venv else ''}")
    print(f"unit:  {res.unit_path}  ({res.platform})")
    print("\nNothing was loaded or enabled. To start the daemon at login, run:")
    for c in res.load_commands:
        print(f"  {c}")
    print("\nTo stop and remove it:")
    for c in res.unload_commands:
        print(f"  {c}")
    return 0


def cmd_check(a: argparse.Namespace) -> int:
    from .backends import OnnxBackend

    try:
        b = OnnxBackend(a.model_dir, warmup=False)
    except ContractError as e:
        print(e, file=sys.stderr)
        return 2
    print(f"ok: run_id={b.run_id} heads={ {h: len(l) for h, l in b.heads.items()} } max_len={b.contract.max_len}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="agento-brain", description="agento local System-1 router daemon")
    p.add_argument("--version", action="version", version=f"agento-brain {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the daemon")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--socket", type=Path, help="unix socket path (default: $AGENTO_HOME/brain.sock)")
    g.add_argument("--port", type=int, help="listen on 127.0.0.1:PORT instead of a unix socket")
    s.add_argument("--model-dir", type=Path, help="artifact dir (see CONTRACT.md); without one, the rules-v1 fallback is served")
    s.add_argument("--rules", action="store_true", help="force the rules-v1 fallback even if a model dir exists")
    s.add_argument("--pid-file", type=Path, help="default: $AGENTO_HOME/brain.pid (socket mode)")
    s.add_argument("--no-pid-file", action="store_true")
    s.set_defaults(fn=cmd_serve)

    i = sub.add_parser("install", help="create venv + launchd/systemd unit file (does not load it)")
    i.add_argument("--model-dir", type=Path, help="bake --model-dir into the unit")
    i.add_argument("--source", help="pip source for the venv (default: this checkout, else PyPI name)")
    i.add_argument("--skip-venv", action="store_true")
    i.add_argument("--unit-dir", type=Path, help=argparse.SUPPRESS)
    i.add_argument("--platform", choices=["macos", "linux"], help=argparse.SUPPRESS)
    i.set_defaults(fn=cmd_install)

    c = sub.add_parser("check", help="validate a model dir against the contract and exit")
    c.add_argument("model_dir", type=Path)
    c.set_defaults(fn=cmd_check)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
