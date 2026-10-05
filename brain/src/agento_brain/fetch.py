"""`agento-brain fetch`: download a trained model, check it, and put it in place.

A model is a .tar.gz of the four contract files (CONTRACT.md). The archive is checked against its sha256 before it is
opened, unpacked into a staging directory next to the target, validated against the contract, and only then swapped in;
the previous model is kept as `model.prev`. Nothing is half-replaced: any failure leaves the current model as it was.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Callable, BinaryIO

from . import contract as C
from .paths import default_model_dir

CHUNK = 1 << 20


class FetchError(Exception):
    pass


@dataclass(frozen=True)
class ModelRef:
    name: str
    url: str
    sha256: str
    size: int | None = None


def registry() -> dict[str, ModelRef]:
    """Published models (models.json in the package): name -> where to get it and its checksum. `latest` is an alias."""
    raw = json.loads(resources.files("agento_brain").joinpath("models.json").read_text(encoding="utf-8"))
    out: dict[str, ModelRef] = {}
    for name, m in raw.get("models", {}).items():
        out[name] = ModelRef(name, m["url"], m["sha256"].lower(), m.get("size"))
    latest = raw.get("latest")
    if latest in out:
        out["latest"] = out[latest]
    return out


def resolve(name_or_url: str, sha256: str | None) -> ModelRef:
    if "://" in name_or_url:
        if not sha256:
            raise FetchError("a model given by URL needs --sha256")
        return ModelRef(name_or_url, name_or_url, sha256.lower())
    reg = registry()
    if name_or_url not in reg:
        known = ", ".join(sorted(reg)) or "none yet"
        raise FetchError(f"unknown model {name_or_url!r} (published: {known})")
    ref = reg[name_or_url]
    if sha256 and sha256.lower() != ref.sha256:
        raise FetchError("--sha256 does not match the published checksum")
    return ref


Opener = Callable[[str], BinaryIO]


def _open_url(url: str) -> BinaryIO:
    if not url.startswith(("https://", "file://")):
        raise FetchError("only https:// (or file://) URLs are fetched")
    return urllib.request.urlopen(url, timeout=60)  # noqa: S310 - scheme checked above


def download(ref: ModelRef, into: Path, *, opener: Opener = _open_url, progress: Callable[[int], None] | None = None) -> Path:
    path = into / "model.tar.gz"
    h = hashlib.sha256()
    n = 0
    with opener(ref.url) as src, open(path, "wb") as dst:
        while chunk := src.read(CHUNK):
            h.update(chunk)
            dst.write(chunk)
            n += len(chunk)
            if progress:
                progress(n)
    if h.hexdigest() != ref.sha256:
        raise FetchError(f"checksum mismatch: got {h.hexdigest()}, expected {ref.sha256}")
    return path


def unpack(archive: Path, into: Path) -> Path:
    """Only regular files, only flat names: no links, no directories outside, no absolute paths."""
    out = into / "model"
    out.mkdir()
    with tarfile.open(archive, "r:gz") as tar:
        for m in tar.getmembers():
            if m.isdir():
                continue
            if not m.isfile():
                raise FetchError(f"archive member {m.name!r} is not a regular file")
            name = Path(m.name).name
            if name in ("", ".", "..") or name.startswith("."):
                raise FetchError(f"archive member {m.name!r} has no usable name")
            f = tar.extractfile(m)
            assert f is not None
            with f, open(out / name, "wb") as dst:
                shutil.copyfileobj(f, dst, CHUNK)
    return out


def fetch(name_or_url: str = "latest", *, sha256: str | None = None, dest: Path | None = None, opener: Opener = _open_url,
          progress: Callable[[int], None] | None = None) -> tuple[ModelRef, Path, str]:
    ref = resolve(name_or_url, sha256)
    target = (dest or default_model_dir()).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent, prefix=".fetch-") as tmp:
        staged = unpack(download(ref, Path(tmp), opener=opener, progress=progress), Path(tmp))
        try:
            run_id = C.validate_files(staged).run_id
        except C.ContractError as e:
            raise FetchError(f"the downloaded model breaks the contract: {e}") from e
        prev = target.with_name(target.name + ".prev")
        if prev.exists():
            shutil.rmtree(prev)
        if target.exists():
            target.rename(prev)
        staged.rename(target)
    return ref, target, run_id
