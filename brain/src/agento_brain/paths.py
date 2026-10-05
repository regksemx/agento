from __future__ import annotations

import os
from pathlib import Path


def agento_home() -> Path:
    return Path(os.environ.get("AGENTO_HOME") or Path.home() / ".agento").expanduser()


def default_socket() -> Path:
    return agento_home() / "brain.sock"


def default_pid_file() -> Path:
    return agento_home() / "brain.pid"


def default_model_dir() -> Path:
    return agento_home() / "brain" / "model"
