"""Install, update, uninstall, purge -- and what each one must not touch."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from hermes_itsuki import __version__
from hermes_itsuki.cli import main
from hermes_itsuki.installer import (
    deployed_version,
    install,
    is_ours,
    plugin_dir,
    uninstall,
    venv_candidates,
)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr("hermes_itsuki.installer.ensure_sdk", lambda _home: (True, "sdk ok"))
    return tmp_path


def test_install_deploys_a_loadable_plugin_directory(home):
    ok, notes = install(str(home))
    assert ok, notes
    target = plugin_dir(home)
    for expected in ("__init__.py", "provider.py", "_kernel.py", "plugin.yaml", "VERSION"):
        assert (target / expected).exists(), expected
    assert is_ours(target)
    assert deployed_version(str(home)) == __version__


def test_plugin_yaml_declares_the_sdk_dependency(home):
    install(str(home))
    text = (plugin_dir(home) / "plugin.yaml").read_text(encoding="utf-8")
    assert "name: itsuki" in text and "itsuki>=0.3,<0.4" in text


def test_install_never_overwrites_a_directory_it_does_not_own(home):
    """Someone else's plugins/itsuki is theirs, not ours."""
    target = plugin_dir(home)
    target.mkdir(parents=True)
    (target / "__init__.py").write_text("# not ours", encoding="utf-8")

    ok, notes = install(str(home))
    assert not ok
    assert "was not created by hermes-itsuki" in " ".join(notes)
    assert (target / "__init__.py").read_text(encoding="utf-8") == "# not ours"


def test_reinstall_refreshes_the_copy_in_place(home):
    install(str(home))
    stale = plugin_dir(home) / "VERSION"
    stale.write_text("0.0.1\n", encoding="utf-8")
    ok, _ = install(str(home))
    assert ok and deployed_version(str(home)) == __version__


def test_uninstall_preserves_state_by_default(home):
    install(str(home))
    state = home / "itsuki"
    state.mkdir(exist_ok=True)
    (state / "keepme").write_text("pending work", encoding="utf-8")
    config = home / "itsuki.json"
    config.write_text("{}", encoding="utf-8")

    ok, _ = uninstall(str(home))
    assert ok
    assert not plugin_dir(home).exists()
    assert (state / "keepme").exists() and config.exists()


def test_purge_removes_both_owned_paths(home):
    """The complete owned set: the state directory AND the config file."""
    install(str(home))
    state = home / "itsuki"
    state.mkdir(exist_ok=True)
    (state / "spool").mkdir(exist_ok=True)
    config = home / "itsuki.json"
    config.write_text('{"capture": "auto"}', encoding="utf-8")

    ok, _ = uninstall(str(home), purge=True)
    assert ok
    assert not plugin_dir(home).exists()
    assert not state.exists(), "purge must remove the state directory"
    assert not config.exists(), "purge must remove itsuki.json too"


def test_uninstall_states_that_the_sdk_remains(home):
    """We do not remove a shared dependency on a guess -- and we say so."""
    install(str(home))
    _ok, notes = uninstall(str(home))
    assert any("left the itsuki SDK" in note for note in notes)


def test_uninstall_leaves_a_foreign_directory_alone(home):
    target = plugin_dir(home)
    target.mkdir(parents=True)
    (target / "__init__.py").write_text("# someone else", encoding="utf-8")
    ok, _ = uninstall(str(home), purge=True)
    assert not ok and target.exists()


def test_venv_candidates_cover_both_platforms(home):
    paths = [str(path) for path in venv_candidates(home)]
    assert any(path.endswith(os.path.join("hermes-agent", "venv")) for path in paths)


def test_doctor_reports_without_leaking_the_credential(home, monkeypatch, capsys):
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_supersecret0123456789")
    install(str(home))
    main(["--hermes-home", str(home), "doctor"])
    output = capsys.readouterr().out
    assert "hermes-itsuki" in output
    assert "supersecret" not in output


def test_doctor_json_is_machine_readable(home, capsys):
    install(str(home))
    main(["--hermes-home", str(home), "doctor", "--json"])
    import json

    report = json.loads(capsys.readouterr().out)
    assert report["version"] == __version__
    assert any(entry["check"] == "plugin-deployed" for entry in report["checks"])


def test_doctor_flags_a_missing_install(home, capsys):
    code = main(["--hermes-home", str(home), "doctor"])
    assert code == 1
    assert "not installed" in capsys.readouterr().out
