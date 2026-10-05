import plistlib

from agento_brain import install as I


def test_macos_plist_written_not_loaded(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTO_HOME", str(tmp_path / "home"))
    calls = []
    res = I.install(model_dir=tmp_path / "m", source=None, skip_venv=True, unit_dir=tmp_path / "units", platform="macos", run=lambda *a, **k: calls.append(a))
    assert calls == []  # skip_venv: nothing executed, and install never calls launchctl
    pl = plistlib.loads(res.unit_path.read_bytes())
    assert pl["Label"] == "dev.agento.brain" and pl["KeepAlive"] is True
    assert pl["ProgramArguments"][1:] == ["serve", "--model-dir", str(tmp_path / "m")]
    assert pl["ProgramArguments"][0].endswith("brain/.venv/bin/agento-brain")
    assert pl["EnvironmentVariables"]["AGENTO_HOME"] == str(tmp_path / "home")
    assert res.load_commands[0].startswith("launchctl bootstrap gui/")


def test_linux_unit_written_not_enabled(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTO_HOME", str(tmp_path / "my home"))
    res = I.install(model_dir=None, source=None, skip_venv=True, unit_dir=tmp_path / "units", platform="linux")
    txt = res.unit_path.read_text()
    assert res.unit_path.name == "agento-brain.service"
    assert "Restart=on-failure" in txt and "WantedBy=default.target" in txt
    assert 'Environment=AGENTO_HOME="' in txt  # path with a space is quoted
    assert "ExecStart=" in txt and "--model-dir" not in txt
    assert res.load_commands == ["systemctl --user daemon-reload", "systemctl --user enable --now agento-brain.service"]


def test_venv_creation_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTO_HOME", str(tmp_path / "home"))
    calls = []
    I.install(model_dir=None, source="/src/brain", skip_venv=False, unit_dir=tmp_path / "u", platform="linux", run=lambda cmd, **k: calls.append(cmd))
    flat = [" ".join(map(str, c)) for c in calls]
    assert any(".venv" in c and ("venv" in c) for c in flat)
    assert any("/src/brain" in c for c in flat)
    assert all("launchctl" not in c and "systemctl" not in c for c in flat)
