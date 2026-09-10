#!/usr/bin/env python3
"""Build the standalone Linux amd64 plugin and collect binary license notices."""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from collect_licenses import collect
from common import GOARCH, GOOS, LIBRARY_NAME, ROOT, check_linux_amd64_library, run, sha256, version


class ApplicationHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.scripts = 0
        self.external_assets = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script":
            self.scripts += 1
            self.external_assets |= "src" in attributes
        if tag == "link" and "stylesheet" in (attributes.get("rel") or "").split():
            self.external_assets |= "href" in attributes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", default=os.environ.get("CPA_PLUGIN_GO", "go"), help="Go executable")
    parser.add_argument("--skip-web", action="store_true", help="Reuse an already built web/dist/index.html")
    parser.add_argument("--test", action="store_true", help="Run frontend and Go tests before building the library")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    env = os.environ.copy()
    # Only this target is supported and described by the first release.
    env.update({"CGO_ENABLED": "1", "GOOS": GOOS, "GOARCH": GOARCH})
    host = json.loads(subprocess.check_output(
        [args.go, "env", "-json", "GOVERSION", "GOHOSTOS", "GOHOSTARCH"], cwd=ROOT, env=env, text=True
    ))
    match = re.match(r"go(\d+)\.(\d+)", host["GOVERSION"])
    if not match or tuple(map(int, match.groups())) < (1, 26):
        raise ValueError("Go 1.26 or newer is required; allow Go toolchain selection or use --go")
    if (host["GOHOSTOS"], host["GOHOSTARCH"]) != (GOOS, GOARCH):
        raise ValueError("This plugin is built and verified only on native Linux amd64")

    web_dir = ROOT / "web"
    if not args.skip_web:
        run(["npm", "ci"], cwd=web_dir)
        run(["npm", "run", "build"], cwd=web_dir)
    html_file = web_dir / "dist" / "index.html"
    if not html_file.is_file():
        raise ValueError("Missing web/dist/index.html; build the frontend first")
    document = ApplicationHTML()
    document.feed(html_file.read_text(encoding="utf-8"))
    if not document.scripts or document.external_assets:
        raise ValueError("web/dist/index.html must contain an inline single-file application")
    if args.test:
        run(["npm", "test"], cwd=web_dir)
        run([args.go, "test", "-buildvcs=false", "./..."], env=env)

    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    binary = out_dir / LIBRARY_NAME
    run([args.go, "build", "-trimpath", "-buildvcs=false", "-buildmode=c-shared", "-o", str(binary), "."], env=env)
    check_linux_amd64_library(binary)
    collect(args.go, out_dir / "THIRD_PARTY_LICENSES.txt")
    build_info = {
        "id": "cpa-usage-statistics", "version": version(), "goos": GOOS, "goarch": GOARCH,
        "go_version": host["GOVERSION"], "binary_sha256": sha256(binary),
        "web_sha256": sha256(html_file),
    }
    (out_dir / "build-info.json").write_text(json.dumps(build_info, indent=2) + "\n", encoding="utf-8")
    print(f"Built {binary}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        sys.exit(1)
