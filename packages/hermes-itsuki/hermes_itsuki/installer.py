"""Put the provider where every supported host will actually find it.

Two facts force this design, and both were measured rather than assumed:

* **PyPI hermes-agent 0.19.0 has no entry-point discovery at all.** Its loader
  scans exactly two places -- bundled providers, and ``$HERMES_HOME/plugins/``.
  An entry-point-only package is invisible there.
* **The official installer's update path is ``git pull`` + ``uv sync --locked``**,
  an *exact* sync that prunes anything not in the host's lockfile. Anything we
  pip-install into that venv can vanish on the next ``hermes update``.

So the wheel stays the audited artifact, and this module copies its own modules
into ``$HERMES_HOME/plugins/itsuki/`` -- outside the venv, outside the git
checkout, and therefore untouched by both. The copy carries a VERSION file so
``doctor`` can notice when it drifts from the installed package, which is the
failure mode the file-copy approach is otherwise prone to.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

MARKER_NAME = ".itsuki-owned"
VERSION_NAME = "VERSION"
PLUGIN_DIRNAME = "itsuki"

#: Copied into the deployed plugin. Everything the provider needs at runtime.
_MODULES = (
    "__init__.py",
    "provider.py",
    "recall.py",
    "capture.py",
    "spool.py",
    "sanitize.py",
    "errors.py",
    "identity.py",
    "config.py",
    "_kernel.py",
)

_PLUGIN_YAML = """name: itsuki
version: {version}
description: "Itsuki - durable memory with bounded recall and exactly-once capture."
pip_dependencies:
  - "itsuki>=0.3,<0.4"
"""


def hermes_home(explicit: Optional[str] = None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("HERMES_HOME")
    return Path(env) if env else Path.home() / ".hermes"


def venv_candidates(home: Path) -> List[Path]:
    """Where the host's virtualenv lives, in the order the installers create it.

    ``install.sh`` puts it at ``<install-dir>/venv`` with install-dir defaulting
    to ``~/.hermes/hermes-agent``; ``install.ps1`` uses ``$HERMES_HOME`` when set
    and ``%LOCALAPPDATA%\\hermes\\hermes-agent`` otherwise.
    """
    candidates = [home / "hermes-agent" / "venv"]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(local_app_data) / "hermes" / "hermes-agent" / "venv")
    candidates.append(Path("/usr/local/lib/hermes-agent/venv"))
    return candidates


def venv_python(home: Path) -> Optional[Path]:
    for venv in venv_candidates(home):
        for relative in ("Scripts/python.exe", "bin/python", "bin/python3"):
            candidate = venv / relative
            if candidate.exists():
                return candidate
    return None


def find_uv(home: Path) -> Optional[Path]:
    """uv first: the host venv is uv-managed and need not contain pip at all."""
    bundled = home / "bin" / ("uv.exe" if os.name == "nt" else "uv")
    if bundled.exists():
        return bundled
    found = shutil.which("uv")
    return Path(found) if found else None


def sdk_install_command(home: Path, python: Path) -> Optional[List[str]]:
    """The command that puts the SDK where the host can import it."""
    uv = find_uv(home)
    if uv is not None:
        return [str(uv), "pip", "install", "--python", str(python), "itsuki>=0.3,<0.4"]
    probe = subprocess.run(
        [str(python), "-c", "import pip"], capture_output=True, text=True
    )
    if probe.returncode == 0:
        return [str(python), "-m", "pip", "install", "itsuki>=0.3,<0.4"]
    return None


def ensure_sdk(home: Path) -> Tuple[bool, str]:
    """Make ``import itsuki`` work inside the host, or say exactly why not."""
    python = venv_python(home)
    if python is None:
        roots = "\n  ".join(str(path) for path in venv_candidates(home))
        return False, f"Could not find the Hermes virtualenv. Looked in:\n  {roots}"
    check = subprocess.run(
        [str(python), "-c", "import itsuki; print(itsuki.__name__)"],
        capture_output=True,
        text=True,
    )
    if check.returncode == 0:
        return True, "itsuki is importable by Hermes"
    command = sdk_install_command(home, python)
    if command is None:
        return False, (
            "Neither uv nor pip is available for the Hermes environment. Install the SDK with:\n"
            f'  uv pip install --python "{python}" "itsuki>=0.3,<0.4"'
        )
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        return False, "Installing the itsuki SDK failed. Run this yourself:\n  " + " ".join(command)
    verify = subprocess.run([str(python), "-c", "import itsuki"], capture_output=True, text=True)
    if verify.returncode != 0:
        return False, "The SDK installed but Hermes still cannot import it."
    return True, "installed the itsuki SDK into the Hermes environment"


def plugin_dir(home: Path) -> Path:
    return home / "plugins" / PLUGIN_DIRNAME


def is_ours(target: Path) -> bool:
    return (target / MARKER_NAME).exists()


def install(home: Optional[str] = None) -> Tuple[bool, List[str]]:
    """Deploy the plugin directory. Never overwrites something we do not own."""
    root = hermes_home(home)
    target = plugin_dir(root)
    notes: List[str] = []

    if target.exists() and not is_ours(target):
        return False, [
            f"{target} exists and was not created by hermes-itsuki.",
            "Move it aside and re-run; this command never overwrites files it does not own.",
        ]
    if target.is_symlink():
        return False, [f"{target} is a symlink; refusing to write through it."]

    source = Path(__file__).resolve().parent
    target.mkdir(parents=True, exist_ok=True)
    for module in _MODULES:
        origin = source / module
        if not origin.exists():
            return False, [f"packaged module missing: {module}"]
        shutil.copy2(origin, target / module)

    from . import __version__

    (target / "plugin.yaml").write_text(_PLUGIN_YAML.format(version=__version__), encoding="utf-8")
    (target / VERSION_NAME).write_text(__version__ + "\n", encoding="utf-8")
    (target / MARKER_NAME).write_text("hermes-itsuki\n", encoding="utf-8")
    if os.name != "nt":
        try:
            os.chmod(target, 0o700)
        except OSError:
            pass
    notes.append(f"deployed the provider to {target}")

    ok, message = ensure_sdk(root)
    notes.append(message)
    if not ok:
        return False, notes

    notes.append("Activate it with: hermes memory setup   (or: hermes config set memory.provider itsuki)")
    return True, notes


def uninstall(home: Optional[str] = None, purge: bool = False) -> Tuple[bool, List[str]]:
    """Remove the plugin, and only with --purge the state it wrote.

    Preconditions run before anything is deleted: a refused purge that has
    already half-removed the install is worse than no purge at all.
    """
    from .config import CONFIG_FILENAME, STATE_DIRNAME

    root = hermes_home(home)
    target = plugin_dir(root)
    notes: List[str] = []

    if target.exists() and not is_ours(target):
        return False, [f"{target} was not created by hermes-itsuki; leaving it alone."]

    state_dir = root / STATE_DIRNAME
    config_file = root / CONFIG_FILENAME
    if purge:
        for path in (state_dir, config_file):
            if path.exists() and not _contained(path, root):
                return False, [f"refusing to purge {path}: outside HERMES_HOME"]
            if path.is_symlink():
                return False, [f"refusing to purge {path}: it is a symlink"]

    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
        notes.append(f"removed {target}")

    if purge:
        if state_dir.exists():
            shutil.rmtree(state_dir, ignore_errors=True)
            notes.append(f"removed {state_dir}")
        if config_file.exists():
            config_file.unlink(missing_ok=True)
            notes.append(f"removed {config_file}")
    else:
        notes.append(f"kept {state_dir} and {config_file} (use --purge to remove them)")

    # The SDK stays: pip metadata cannot prove nothing else in that
    # environment imports it, and removing a shared dependency on a guess is
    # worse than leaving one package installed.
    notes.append("left the itsuki SDK installed in the Hermes environment (other tools may use it)")
    return True, notes


def deployed_version(home: Optional[str] = None) -> Optional[str]:
    path = plugin_dir(hermes_home(home)) / VERSION_NAME
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _contained(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def windows_dacl_report(path: Path) -> Dict[str, str]:
    """Verify owner-only access on Windows rather than assuming it.

    "It is under the user profile" is not an access-control statement. This
    asks the OS who actually has rights.
    """
    if os.name != "nt":
        return {"status": "not-applicable", "detail": "POSIX mode bits are used instead"}
    try:
        result = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"status": "unknown", "detail": f"icacls failed: {exc}"}
    if result.returncode != 0:
        return {"status": "unknown", "detail": "icacls returned a non-zero status"}
    text = result.stdout
    broad = [token for token in ("Everyone", "BUILTIN\\Users", "Authenticated Users") if token in text]
    if broad:
        return {"status": "not-verified", "detail": "broad grants present: " + ", ".join(broad)}
    return {"status": "verified", "detail": "no broad grants on the state directory"}
