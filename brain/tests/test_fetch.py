import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from agento_brain import fetch as F


def _tar(files: dict[str, bytes], *, prefix: str = "opus-v1/", symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(prefix + name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
        if symlink:
            info = tarfile.TarInfo(prefix + symlink)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            t.addfile(info)
    return buf.getvalue()


def _model_files(model_dir: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in model_dir.iterdir() if p.is_file()}


def _opener(blob: bytes):
    return lambda url: io.BytesIO(blob)


def test_fetch_by_url_checks_and_swaps_in(model_dir, tmp_path):
    blob = _tar(_model_files(model_dir))
    dest = tmp_path / "brain" / "model"
    dest.mkdir(parents=True)
    (dest / "old.txt").write_text("previous")
    ref, target, run_id = F.fetch("https://example.test/m.tar.gz", sha256=hashlib.sha256(blob).hexdigest(), dest=dest, opener=_opener(blob))
    assert target == dest and run_id
    assert sorted(p.name for p in dest.iterdir()) == sorted(_model_files(model_dir))
    assert (tmp_path / "brain" / "model.prev" / "old.txt").read_text() == "previous"
    assert not [p for p in (tmp_path / "brain").iterdir() if p.name.startswith(".fetch-")]


def test_a_wrong_checksum_changes_nothing(model_dir, tmp_path):
    blob = _tar(_model_files(model_dir))
    dest = tmp_path / "model"
    dest.mkdir()
    (dest / "keep.txt").write_text("x")
    with pytest.raises(F.FetchError, match="checksum"):
        F.fetch("https://example.test/m.tar.gz", sha256="0" * 64, dest=dest, opener=_opener(blob))
    assert [p.name for p in dest.iterdir()] == ["keep.txt"]


def test_a_model_that_breaks_the_contract_is_refused(model_dir, tmp_path):
    files = _model_files(model_dir)
    del files["heads.json"]
    blob = _tar(files)
    with pytest.raises(F.FetchError, match="contract"):
        F.fetch("https://example.test/m.tar.gz", sha256=hashlib.sha256(blob).hexdigest(), dest=tmp_path / "model", opener=_opener(blob))
    assert not (tmp_path / "model").exists()


def test_links_in_the_archive_are_refused(model_dir, tmp_path):
    blob = _tar(_model_files(model_dir), symlink="evil")
    with pytest.raises(F.FetchError, match="regular file"):
        F.fetch("https://example.test/m.tar.gz", sha256=hashlib.sha256(blob).hexdigest(), dest=tmp_path / "model", opener=_opener(blob))


def test_a_url_needs_a_checksum_and_plain_http_is_refused():
    with pytest.raises(F.FetchError, match="sha256"):
        F.resolve("https://example.test/m.tar.gz", None)
    with pytest.raises(F.FetchError, match="https"):
        F._open_url("http://example.test/m.tar.gz")


def test_an_unknown_name_lists_what_is_published():
    with pytest.raises(F.FetchError, match="published"):
        F.resolve("no-such-model", None)
