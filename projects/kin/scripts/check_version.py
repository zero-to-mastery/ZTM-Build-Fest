#!/usr/bin/env python3
import json
import re
import sys
import tomllib
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def require_match(label: str, pattern: str, text: str, version: str) -> None:
    match = re.search(pattern, text, re.MULTILINE)
    actual = match.group(1) if match else None
    if actual != version:
        raise ValueError(f"{label}: expected {version}, found {actual or 'no version'}")


def main() -> int:
    cargo = tomllib.loads((PROJECT_ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    version = cargo.get("package", {}).get("version")
    if not isinstance(version, str):
        raise ValueError("Cargo.toml: package.version is missing or invalid")

    lock = tomllib.loads((PROJECT_ROOT / "Cargo.lock").read_text(encoding="utf-8"))
    kin_packages = [package for package in lock.get("package", []) if package.get("name") == "kin"]
    if len(kin_packages) != 1 or kin_packages[0].get("version") != version:
        locked = ", ".join(package.get("version", "?") for package in kin_packages) or "no kin package"
        raise ValueError(f"Cargo.lock: expected one kin package at {version}, found {locked}")

    readme = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")
    require_match(
        "README last published release",
        r"^\*\*Last published release: `v([0-9]+\.[0-9]+\.[0-9]+)`",
        readme,
        version,
    )
    require_match(
        "README release history",
        rf"^- `v({re.escape(version)})` —",
        readme,
        version,
    )

    changelog = (PROJECT_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    require_match(
        "CHANGELOG latest published release",
        r"^## v([0-9]+\.[0-9]+\.[0-9]+)(?: —|$)",
        changelog,
        version,
    )

    issue_template = (PROJECT_ROOT / ".github/ISSUE_TEMPLATE/bug_report.yml").read_text(encoding="utf-8")
    require_match("bug report version placeholder", r"^\s+placeholder: kin-v([0-9]+\.[0-9]+\.[0-9]+)$", issue_template, version)

    agents = (PROJECT_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    if f"kin-v{version}" not in agents:
        raise ValueError(f"AGENTS.md: tag list is missing kin-v{version}")

    server_package = json.loads(
        (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
    )
    server_version = server_package.get("version")
    if not isinstance(server_version, str):
        raise ValueError("package.json: server package.version is missing or invalid")
    if server_version != version:
        require_match(
            "README durable-service candidate",
            rf"`v({re.escape(server_version)})` durable-service implementation candidate",
            readme,
            server_version,
        )
        require_match(
            "CHANGELOG durable-service candidate",
            r"^## Unreleased — v[0-9]+\.[0-9]+\.[0-9]+–v([0-9]+\.[0-9]+\.[0-9]+) Durable Service & Deployment candidate$",
            changelog,
            server_version,
        )
        if f"v{server_version}" not in agents:
            raise ValueError(
                f"AGENTS.md: durable-service candidate v{server_version} is missing"
            )

    print(
        f"Kin published version {version} and server version {server_version} "
        "are consistent across their release metadata."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"Kin version check failed: {error}", file=sys.stderr)
        raise SystemExit(1)