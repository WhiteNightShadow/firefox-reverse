#!/usr/bin/env python3
"""Record how one release target was built, without machine paths, so the build can be reproduced later.

The record names the source commits, the mozconfig, the configure options and toolchain versions that
about:buildconfig shows (read from the objdir's config.status.json), a host summary and the packages with
their sha256. Absolute paths become "<path>" and compilers are named by program only; no host name is kept.
Python 3.10 compatible: it runs on the build host.
"""

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shlex
import subprocess
import sys
from pathlib import Path

ABSOLUTE = re.compile(r"^(/|[A-Za-z]:[\\/]|\\\\)")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redact(option):
    """'--with-l10n-base=/x' -> '--with-l10n-base=<path>', 'DMG_TOOL=/x/dmg' -> 'DMG_TOOL=<path>', '/x' -> '<path>'."""
    if "=" in option:
        name, value = option.split("=", 1)
        return f"{name}=<path>" if ABSOLUTE.match(value) else option
    return "<path>" if ABSOLUTE.match(option) else option


def program(value):
    """The program name of a compiler setting such as '/x/clang/bin/clang --sysroot /y' or ['/x/clang']."""
    tokens = value if isinstance(value, list) else shlex.split(str(value or ""))
    return re.split(r"[\\/]", tokens[0])[-1] if tokens else None


def head(directory):
    return subprocess.run(["git", "-C", str(directory), "rev-parse", "HEAD"], check=True,
                          capture_output=True, encoding="utf-8").stdout.strip()


def memory_bytes():
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def build_record(args):
    config = json.loads((Path(args.objdir) / "config.status.json").read_text(encoding="utf-8"))
    substs = dict(config["substs"])
    options = substs.get("MOZ_CONFIGURE_OPTIONS") or ""
    options = options if isinstance(options, list) else shlex.split(options)
    return {
        "target": args.target,
        "version": args.version,
        "buildId": args.build_id,
        "source": {"commit": args.commit, "baseline": head(args.upstream), "l10n": head(args.l10n)},
        "mozconfig": {"file": args.repo_config_name, "sha256": sha256(args.repo_config),
                      "effectiveSha256": sha256(args.mozconfig)},
        "configure": {"target": substs.get("target"), "host": substs.get("host"),
                      "options": [redact(option) for option in options]},
        "toolchain": {"cc": program(substs.get("CC")), "ccVersion": substs.get("CC_VERSION"),
                      "rustcVersion": substs.get("RUSTC_VERSION")},
        "host": {"system": platform.system(), "release": platform.release(), "machine": platform.machine(),
                 "cpus": os.cpu_count(), "memoryBytes": memory_bytes(), "python": platform.python_version()},
        "outputs": [{"name": name, "size": (Path(args.dist) / name).stat().st_size, "sha256": sha256(Path(args.dist) / name)}
                    for name in args.outputs],
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ("--target", "--version", "--build-id", "--commit", "--upstream", "--l10n", "--objdir",
                 "--repo-config", "--repo-config-name", "--mozconfig", "--dist", "--output"):
        parser.add_argument(name, required=True)
    parser.add_argument("outputs", nargs="+", help="package file names inside --dist")
    args = parser.parse_args(argv)
    record = build_record(args)
    Path(args.output).write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    json.dump(record, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
