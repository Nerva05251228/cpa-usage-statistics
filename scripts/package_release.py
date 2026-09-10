#!/usr/bin/env python3
"""Package a verified build for the existing CPA plugin installer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import zipfile

from common import GOARCH, GOOS, LIBRARY_NAME, PLUGIN_ID, ROOT, check_linux_amd64_library, sha256, version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--output-dir", type=Path, help="Default: releases/<plugin version>")
    args = parser.parse_args()
    release_version = version()
    build_dir = args.build_dir.resolve()
    output_dir = (args.output_dir or ROOT / "releases" / release_version).resolve()
    binary = build_dir / LIBRARY_NAME
    check_linux_amd64_library(binary)
    info = json.loads((build_dir / "build-info.json").read_text())
    expected = {"id": PLUGIN_ID, "version": release_version, "goos": GOOS, "goarch": GOARCH, "binary_sha256": sha256(binary)}
    if any(info.get(key) != value for key, value in expected.items()):
        raise ValueError("Build metadata does not match this release; rebuild before packaging")
    files = [
        (binary, LIBRARY_NAME, 0o755),
        (ROOT / "LICENSE", "LICENSE", 0o644),
        (ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md", 0o644),
        (ROOT / "README.md", "README.md", 0o644),
        (ROOT / "README_CN.md", "README_CN.md", 0o644),
        (build_dir / "THIRD_PARTY_LICENSES.txt", "THIRD_PARTY_LICENSES.txt", 0o644),
        (build_dir / "build-info.json", "build-info.json", 0o644),
    ]
    for path, _, _ in files:
        if not path.is_file():
            raise ValueError(f"Missing package input: {path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"{PLUGIN_ID}_{release_version}_{GOOS}_{GOARCH}.zip"
    temporary = archive.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for path, name, mode in files:
                entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (0o100000 | mode) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                package.writestr(entry, path.read_bytes())
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
    (output_dir / "checksums.txt").write_text(f"{sha256(archive)}  {archive.name}\n", encoding="utf-8")
    print(f"Packaged {archive}")
    print(f"SHA256 {sha256(archive)}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        sys.exit(1)
