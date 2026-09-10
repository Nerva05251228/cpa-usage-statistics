#!/usr/bin/env python3
"""Generate a schema-v2 direct-download registry from an actual release ZIP."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote
import zipfile

from common import GOARCH, GOOS, LIBRARY_NAME, PLUGIN_ID, ROOT, sha256, version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="Nerva05251228/cpa-usage-statistics", help="GitHub owner/repository")
    parser.add_argument("--ref", help="Immutable Git tag/ref; default v<version>")
    parser.add_argument("--plugin-path", default="", help="Optional repository subdirectory; default repository root")
    parser.add_argument("--artifacts-dir", type=Path, help="Default: releases/<version>")
    parser.add_argument("--output", type=Path, default=ROOT / "registry.json")
    parser.add_argument("--public", action="store_true", help="Only for a publicly readable repository")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        raise ValueError("--repository must be an owner/repository pair")
    plugin_path = args.plugin_path.strip("/")
    if plugin_path and any(part in ("", ".", "..") for part in plugin_path.split("/")):
        raise ValueError("--plugin-path must be a repository-relative path")
    release_version = version()
    release_ref = args.ref or f"v{release_version}"
    if not release_ref or any(character.isspace() for character in release_ref):
        raise ValueError("--ref must be a non-empty Git ref without whitespace")
    directory = (args.artifacts_dir or ROOT / "releases" / release_version).resolve()
    filename = f"{PLUGIN_ID}_{release_version}_{GOOS}_{GOARCH}.zip"
    archive = directory / filename
    with zipfile.ZipFile(archive) as package:
        if package.namelist().count(LIBRARY_NAME) != 1:
            raise ValueError(f"Package must contain exactly one {LIBRARY_NAME} at its root")
        bad_entry = package.testzip()
        if bad_entry:
            raise ValueError(f"Corrupt ZIP entry: {bad_entry}")
    repository_path = f"{quote(plugin_path, safe='/')}/" if plugin_path else ""
    homepage_path = f"/{quote(plugin_path, safe='/')}" if plugin_path else ""
    artifact_url = f"https://raw.githubusercontent.com/{args.repository}/{quote(release_ref, safe='')}/{repository_path}releases/{release_version}/{filename}"
    registry = {
        "schema_version": 2,
        "plugins": [{
            "id": PLUGIN_ID, "name": "使用统计",
            "description": "独立的 SQLite 使用统计：趋势图、模型/API Key/凭据统计、请求明细与费用估算。需要支持插件页面通信桥的 CPA v7 管理中心。",
            "author": "Nerva05251228", "version": release_version,
            "repository": f"https://github.com/{args.repository}",
            "homepage": f"https://github.com/{args.repository}/tree/{quote(release_ref, safe='')}{homepage_path}",
            "license": "MIT", "tags": ["usage", "statistics", "sqlite"],
            "auth_required": not args.public,
            "install": {"type": "direct", "artifacts": [{
                "goos": GOOS, "goarch": GOARCH, "url": artifact_url,
                "sha256": sha256(archive), "size": archive.stat().st_size,
            }]},
        }],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output.resolve()}")
    print("The registry advertises only the packaged Linux amd64 artifact.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(f"Registry generation failed: {error}", file=sys.stderr)
        sys.exit(1)
