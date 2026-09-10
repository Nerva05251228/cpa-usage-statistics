"""Shared release constants; no host source tree is required."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_ID = "cpa-usage-statistics"
GOOS = "linux"
GOARCH = "amd64"
LIBRARY_NAME = f"{PLUGIN_ID}.so"


def version() -> str:
    match = re.search(r'const\s+pluginVersion\s*=\s*"([0-9][0-9A-Za-z.+-]*)"', (ROOT / "types.go").read_text())
    if not match:
        raise ValueError("Cannot find pluginVersion in types.go")
    return match.group(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(args), flush=True)
    subprocess.run(args, cwd=cwd, env=env, check=True)


def check_linux_amd64_library(path: Path) -> None:
    with path.open("rb") as handle:
        header = handle.read(64)
    # ELF64, little endian, ET_DYN, EM_X86_64. Reject mislabeled platform packages.
    if len(header) < 64 or header[:6] != b"\x7fELF\x02\x01" or header[16:20] != b"\x03\x00\x3e\x00":
        raise ValueError(f"Expected a Linux amd64 shared library: {path}")
