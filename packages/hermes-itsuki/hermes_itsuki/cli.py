"""`hermes-itsuki install | doctor | uninstall`.

Doctor is the heal path, not just a report: the host's own update can prune the
SDK out of its virtualenv, and lazy dependency installation is allowlist-only,
so nothing repairs that automatically. Running doctor puts it back and says so.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import __version__
from .config import CONFIG_FILENAME, STATE_DIRNAME, Config, api_key_from_env
from .installer import (
    deployed_version,
    ensure_sdk,
    hermes_home,
    install,
    is_ours,
    plugin_dir,
    uninstall,
    venv_python,
    windows_dacl_report,
)


def _diagnose(home_arg: Optional[str]) -> Dict[str, Any]:
    home = hermes_home(home_arg)
    config = Config.load(home)
    target = plugin_dir(home)
    python = venv_python(home)
    deployed = deployed_version(home_arg)

    checks: List[Dict[str, str]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "status": "ok" if ok else "attention", "detail": detail})

    check("hermes-home", home.exists(), str(home))
    check(
        "plugin-deployed",
        target.exists() and is_ours(target),
        str(target) if target.exists() else "not installed - run: hermes-itsuki install",
    )
    check(
        "plugin-current",
        deployed == __version__,
        f"deployed {deployed or 'none'} vs package {__version__}"
        + ("" if deployed == __version__ else " - run: hermes-itsuki install"),
    )
    check(
        "hermes-venv",
        python is not None,
        str(python) if python else "not found; is Hermes installed for this user?",
    )
    # Never print the key, only whether one is present.
    check(
        "credential",
        api_key_from_env() is not None,
        "ITSUKI_API_KEY is set" if api_key_from_env() else "set ITSUKI_API_KEY (hermes memory setup)",
    )
    check("service-url", True, config.base_url)
    check("capture", True, "auto" if config.capture_enabled else "off")
    check("recall", True, "auto" if config.recall_enabled else "off")

    state = home / STATE_DIRNAME
    spool_root = state / "spool"
    depth = sum(1 for _ in spool_root.rglob("*.json")) if spool_root.exists() else 0
    check("queue-depth", True, str(depth))
    quarantined = sum(1 for _ in spool_root.rglob("*.quarantine")) if spool_root.exists() else 0
    check(
        "quarantined",
        quarantined == 0,
        f"{quarantined} envelope(s) held back for review" if quarantined else "none",
    )
    if state.exists():
        dacl = windows_dacl_report(state)
        check("windows-dacl", dacl["status"] in ("verified", "not-applicable"), dacl["detail"])

    return {
        "version": __version__,
        "hermes_home": str(home),
        "config_file": str(home / CONFIG_FILENAME),
        "checks": checks,
    }


def _print(report: Dict[str, Any]) -> None:
    print(f"hermes-itsuki {report['version']}")
    print(f"HERMES_HOME  {report['hermes_home']}")
    for entry in report["checks"]:
        mark = "OK " if entry["status"] == "ok" else "!! "
        print(f"  {mark}{entry['check']:<16} {entry['detail']}")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="hermes-itsuki", description="Itsuki memory for Hermes Agent")
    parser.add_argument("--hermes-home", dest="home", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("install", help="deploy the provider into HERMES_HOME/plugins")
    doctor = sub.add_parser("doctor", help="check the install, and repair the SDK if it was pruned")
    doctor.add_argument("--json", action="store_true")
    doctor.add_argument("--fix", action="store_true", help="reinstall the SDK if Hermes cannot import it")
    remove = sub.add_parser("uninstall", help="remove the provider")
    remove.add_argument("--purge", action="store_true", help="also delete config and spooled state")

    args = parser.parse_args(argv)

    if args.command == "install":
        ok, notes = install(args.home)
        for note in notes:
            print(("  " if ok else "!! ") + note)
        return 0 if ok else 1

    if args.command == "uninstall":
        ok, notes = uninstall(args.home, purge=args.purge)
        for note in notes:
            print(("  " if ok else "!! ") + note)
        return 0 if ok else 1

    report = _diagnose(args.home)
    if args.fix:
        ok, message = ensure_sdk(hermes_home(args.home))
        print(("  " if ok else "!! ") + message)
        report = _diagnose(args.home)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print(report)
    return 0 if all(entry["status"] == "ok" for entry in report["checks"]) else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
