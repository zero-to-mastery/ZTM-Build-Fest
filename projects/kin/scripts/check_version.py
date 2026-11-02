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
        "README current implementation line",
        r"Current implementation line: `v([0-9]+\.[0-9]+\.[0-9]+)`",
        readme,
        version,
    )

    changelog = (PROJECT_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    if not re.search(
        rf"^##(?:#)? (?:Unreleased — )?v{re.escape(version)}[ —]",
        changelog,
        re.MULTILINE,
    ):
        raise ValueError(
            f"CHANGELOG: current implementation line {version} is missing"
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
        raise ValueError(
            f"package.json: expected Kin implementation line {version}, found {server_version}"
        )

    index = (PROJECT_ROOT / "web/index.html").read_text(encoding="utf-8")
    require_match("index release metadata", r'<meta name="kin-version" content="([0-9]+\.[0-9]+\.[0-9]+)"', index, version)
    archive = (PROJECT_ROOT / "web/security/archive.js").read_text(encoding="utf-8")
    require_match("portable archive metadata", r'^const KIN_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";', archive, version)
    worker = (PROJECT_ROOT / "web/service-worker.js").read_text(encoding="utf-8")
    if 'const CACHE = `kin-static-v${RELEASE}`;' not in worker:
        raise ValueError("service worker cache name must derive from the release registration URL")
    # The app shell registers the worker from its status controller.
    app = (PROJECT_ROOT / "web/components/app/status.js").read_text(encoding="utf-8")
    if '/service-worker.js?v=${encodeURIComponent(release ?? "")}' not in app:
        raise ValueError("service worker registration must pass the document release version")

    print(
        f"Kin implementation candidate {version} is consistent across client, "
        "server, and release metadata."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"Kin version check failed: {error}", file=sys.stderr)
        raise SystemExit(1)
