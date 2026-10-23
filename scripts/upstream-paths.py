#!/usr/bin/env python3
"""
Print every upstream file the patch pipeline (scripts/apply-patches.sh) edits:
targets of patches/*/*.patch plus the files the Python patchers rewrite.
CI uses it for a sparse checkout of the pinned Firefox revision, so the whole
pipeline can be applied twice (idempotency) without downloading the full tree.
"""

from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[1]


def main():
    paths = set()
    for patch in sorted((REPO / "patches").glob("*/*.patch")):
        for line in patch.read_text(encoding="utf-8").splitlines():
            if line.startswith("+++ b/"):
                paths.add(line[len("+++ b/"):].strip())
            elif line.startswith("--- a/"):
                paths.add(line[len("--- a/"):].strip())
    for script in ("apply-fingerprint-config.py", "apply-phase-b.py"):
        text = (REPO / "scripts" / script).read_text(encoding="utf-8")
        paths.update(re.findall(r'os\.path\.join\(ROOT, "([^"]+)"\)', text))
        paths.update(re.findall(r'^patch_file\("([^"]+)"', text, re.M))
    paths.discard("/dev/null")
    sys.stdout.write("".join(path + "\n" for path in sorted(paths)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
