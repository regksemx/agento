"""`agento-brain install`: venv + service unit files. Writes files only; never loads/enables anything."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .paths import agento_home

LABEL = "dev.agento.brain"
UNIT_NAME = "agento-brain.service"


@dataclass
class InstallResult:
    venv_dir: Path
    exe: Path
    unit_path: Path
    platform: str
    load_commands: list[str]
    unload_commands: list[str]


def detect_source() -> str:
    """Install from this checkout when running from source (brain/pyproject.toml), else from the package index."""
    here = Path(__file__).resolve()
    root = here.parents[2]
    if (root / "pyproject.toml").is_file() and (root / "src" / "agento_brain").is_dir():
        return str(root)
    return "agento-brain"


def create_venv(venv_dir: Path, source: str, *, run=subprocess.run) -> None:
    venv_dir.parent.mkdir(parents=True, exist_ok=True)
    py = venv_dir / "bin" / "python"
    uv = shutil.which("uv")
    if uv:
        run([uv, "venv", "--python", f"{sys.version_info.major}.{sys.version_info.minor}", str(venv_dir)], check=True)
        run([uv, "pip", "install", "--python", str(py), source], check=True)
    else:
        run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        run([str(py), "-m", "pip", "install", "--upgrade", "pip"], check=True)
        run([str(py), "-m", "pip", "install", source], check=True)


def _serve_args(exe: Path, model_dir: Path | None) -> list[str]:
    args = [str(exe), "serve"]
    if model_dir is not None:
        args += ["--model-dir", str(model_dir)]
    return args


def _systemd_quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' if any(c in s for c in ' \t"\\') else s


def render_plist(args: list[str], home: Path, log: Path) -> bytes:
    return plistlib.dumps(
        {
            "Label": LABEL,
            "ProgramArguments": args,
            "RunAtLoad": True,
            "KeepAlive": True,
            "ProcessType": "Background",
            "EnvironmentVariables": {"AGENTO_HOME": str(home)},
            "StandardOutPath": str(log),
            "StandardErrorPath": str(log),
        }
    )


def render_systemd(args: list[str], home: Path) -> str:
    return (
        "[Unit]\nDescription=agento brain (local System-1 router)\nAfter=default.target\n\n"
        "[Service]\nType=simple\n"
        f"Environment=AGENTO_HOME={_systemd_quote(str(home))}\n"
        f"ExecStart={' '.join(_systemd_quote(a) for a in args)}\n"
        "Restart=on-failure\nRestartSec=2\n\n"
        "[Install]\nWantedBy=default.target\n"
    )


def install(*, model_dir: Path | None, source: str | None, skip_venv: bool, unit_dir: Path | None = None, platform: str | None = None,
            run=subprocess.run) -> InstallResult:
    home = agento_home()
    venv_dir = home / "brain" / ".venv"
    plat = platform or ("macos" if sys.platform == "darwin" else "linux")
    if plat not in ("macos", "linux"):
        raise ValueError(f"unsupported platform {plat!r}")
    if not skip_venv:
        create_venv(venv_dir, source or detect_source(), run=run)
    exe = venv_dir / "bin" / "agento-brain"
    args = _serve_args(exe, model_dir)
    (home / "brain").mkdir(parents=True, exist_ok=True)
    if plat == "macos":
        d = unit_dir or Path.home() / "Library" / "LaunchAgents"
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{LABEL}.plist"
        path.write_bytes(render_plist(args, home, home / "brain" / "brain.log"))
        uid = os.getuid()
        load = [f"launchctl bootstrap gui/{uid} {path}", f"launchctl kickstart -k gui/{uid}/{LABEL}"]
        unload = [f"launchctl bootout gui/{uid}/{LABEL}"]
    else:
        d = unit_dir or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user"
        d.mkdir(parents=True, exist_ok=True)
        path = d / UNIT_NAME
        path.write_text(render_systemd(args, home), encoding="utf-8")
        load = ["systemctl --user daemon-reload", f"systemctl --user enable --now {UNIT_NAME}"]
        unload = [f"systemctl --user disable --now {UNIT_NAME}"]
    path.chmod(0o644)
    return InstallResult(venv_dir, exe, path, plat, load, unload)
