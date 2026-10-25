#!/usr/bin/env python3
"""Check that the Windows installer ships the same browser as the portable ZIP.

The installer is never executed: 7-Zip extracts its core/ payload and every file must match the
ZIP's firefox/ tree byte for byte. The native checks only run the ZIP, so this is what ties the
installer to the verified build."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return digest(stream)


def tree_digests(root):
    return {path.relative_to(root).as_posix(): file_digest(path) for path in sorted(root.rglob("*")) if path.is_file()}


def zip_digests(archive_path, prefix="firefox/"):
    digests = {}
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            if not info.is_dir() and info.filename.startswith(prefix):
                with archive.open(info) as stream:
                    digests[info.filename[len(prefix):]] = digest(stream)
    return digests


def compare(installer, portable):
    shared = sorted(set(installer) & set(portable))
    return {
        "matched": [name for name in shared if installer[name] == portable[name]],
        "mismatched": [name for name in shared if installer[name] != portable[name]],
        "onlyInInstaller": sorted(set(installer) - set(portable)),
        "onlyInZip": sorted(set(portable) - set(installer)),
    }


def find_seven_zip(explicit):
    # The build machine has 7-Zip from mach bootstrap; elsewhere use whatever is installed.
    candidates = [explicit] if explicit else [shutil.which("7zz"), shutil.which("7z"), str(Path.home() / ".mozbuild/7zz/7zz")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit("7-Zip not found; pass --seven-zip")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", required=True, type=Path, help="firefox-reverse-<tag>-windows-x86_64-installer.exe")
    parser.add_argument("--zip", required=True, type=Path, help="firefox-reverse-<tag>-windows-x86_64.zip")
    parser.add_argument("--seven-zip", help="7zz/7z executable (default: PATH, then ~/.mozbuild/7zz/7zz)")
    parser.add_argument("--output", type=Path, help="write the JSON report here")
    args = parser.parse_args()
    seven_zip = find_seven_zip(args.seven_zip)
    with tempfile.TemporaryDirectory(prefix="frx-installer-") as directory:
        subprocess.run([seven_zip, "x", "-y", f"-o{directory}", str(args.installer), "core"], check=True, stdout=subprocess.DEVNULL)
        core = Path(directory) / "core"
        if not core.is_dir():
            raise SystemExit("installer has no core/ payload")
        installer = tree_digests(core)
    portable = zip_digests(args.zip)
    result = compare(installer, portable)
    passed = bool(result["matched"]) and not (result["mismatched"] or result["onlyInInstaller"] or result["onlyInZip"])
    report = {
        "status": "passed" if passed else "failed",
        "mode": "static payload comparison; the installer was not executed",
        "installer": {"name": args.installer.name, "sha256": file_digest(args.installer)},
        "zip": {"name": args.zip.name, "sha256": file_digest(args.zip)},
        "files": len(installer),
        "matched": len(result["matched"]),
        "mismatched": result["mismatched"],
        "onlyInInstaller": result["onlyInInstaller"],
        "onlyInZip": result["onlyInZip"],
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
