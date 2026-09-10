#!/usr/bin/env python3
"""Collect installed Go and frontend dependency notices for binary distribution."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

from common import ROOT


def json_objects(raw: str):
    decoder = json.JSONDecoder()
    raw = raw.lstrip()
    while raw:
        value, end = decoder.raw_decode(raw)
        yield value
        raw = raw[end:].lstrip()


def collect(go: str, output: Path) -> None:
    parts = ["CPA usage statistics: bundled dependency license notices\n"]
    seen: set[Path] = set()
    # yaml.v3 includes Apache-licensed source files; its own notice only links
    # to the terms, so carry the complete license in the binary distribution.
    apache = ROOT / "scripts" / "licenses" / "Apache-2.0.txt"
    parts.append("\ngopkg.in/yaml.v3: complete Apache License, Version 2.0\n\n")
    parts.append(apache.read_text(encoding="utf-8").rstrip() + "\n")

    def add(label: str, directory: Path) -> None:
        if not directory.is_dir():
            return
        candidates = sorted(path for path in directory.iterdir() if path.is_file() and (
            path.name.lower().startswith(("license", "licence", "copying", "notice"))
            or path.name == "PATENTS"
        ))
        for path in candidates:
            if path.resolve() in seen:
                continue
            seen.add(path.resolve())
            parts.append(f"\n{'=' * 72}\n{label} — {path.name}\n{'=' * 72}\n")
            parts.append(path.read_text(encoding="utf-8", errors="replace").rstrip() + "\n")

    goroot = subprocess.check_output([go, "env", "GOROOT"], cwd=ROOT, text=True).strip()
    add("Go runtime", Path(goroot))
    modules = subprocess.check_output([go, "list", "-m", "-json", "all"], cwd=ROOT, text=True)
    for module in json_objects(modules):
        if module.get("Main"):
            continue
        source = module.get("Replace", module)
        if source.get("Dir"):
            add(f"{module['Path']} {module.get('Version', '')}", Path(source["Dir"]))

    npm_paths = subprocess.check_output(
        ["npm", "ls", "--omit=dev", "--all", "--parseable"], cwd=ROOT / "web", text=True
    )
    for name in npm_paths.splitlines():
        directory = Path(name)
        package_file = directory / "package.json"
        if not package_file.is_file() or directory.resolve() == (ROOT / "web").resolve():
            continue
        package = json.loads(package_file.read_text())
        add(f"{package.get('name', directory.name)} {package.get('version', '')}", directory)

    if not seen:
        raise ValueError("No dependency license notices found; install dependencies first")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(parts), encoding="utf-8")
    print(f"Collected {len(seen)} license/notice files into {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", default="go", help="Go executable (default: go)")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "THIRD_PARTY_LICENSES.txt")
    args = parser.parse_args()
    collect(args.go, args.output.resolve())


if __name__ == "__main__":
    main()
