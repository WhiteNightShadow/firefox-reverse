#!/usr/bin/env python3
"""
Sync additions/ into the Firefox source tree, removing what a previous sync
copied but additions/ no longer contains.

rsync -a only adds and overwrites, so a file deleted from additions/ lived on in
long-lived build trees. It also copies source mtimes: after a fresh CI checkout
every file looks new and is recopied (rebuilding everything that includes it),
while a file restored with an old mtime can look older than its object file.
This keeps the copied list in <upstream>/.frx-additions-manifest and:
  - copies only files whose bytes changed (they get a fresh mtime and rebuild;
    unchanged files are not touched);
  - for files a previous run copied that additions/ no longer has: restores the
    ones tracked by the upstream checkout (overridden upstream files) and
    deletes the others.

Usage: sync-additions.py <additions-dir> <upstream-dir> [--exclude PATTERN ...]
A pattern without "/" matches any path component (like rsync); a pattern with
"/" matches that relative path and everything below it. As with rsync, excluded
paths already in the tree are left alone; they stay in the manifest so a later
run that includes them again can still prune them.
"""

import argparse
import filecmp
import fnmatch
import os
import shutil
import subprocess
import sys

DEFAULT_EXCLUDES = ["README.md", "node_modules", "dev", "*.jsx", "package*.json", ".gitignore", ".DS_Store"]
MANIFEST = ".frx-additions-manifest"


def excluded(rel, patterns):
    parts = rel.split("/")
    for pattern in patterns:
        pattern = pattern.strip("/")
        if "/" in pattern:
            if rel == pattern or rel.startswith(pattern + "/"):
                return True
        elif any(fnmatch.fnmatch(part, pattern) for part in parts):
            return True
    return False


def wanted_files(additions, patterns):
    files = []
    for dirpath, dirnames, filenames in os.walk(additions):
        rel_dir = os.path.relpath(dirpath, additions).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        dirnames[:] = sorted(d for d in dirnames if not excluded(rel_dir + d, patterns))
        for name in sorted(filenames):
            rel = rel_dir + name
            if not excluded(rel, patterns) and not os.path.islink(os.path.join(dirpath, name)):
                files.append(rel)
    return files


def tracked_by_upstream(upstream, rel):
    """True/False when the upstream checkout says so, None when it cannot tell."""
    try:
        result = subprocess.run(["git", "--literal-pathspecs", "-C", upstream, "ls-files", "--error-unmatch", "--", rel],
                                capture_output=True)
    except OSError:
        return None
    if result.returncode == 0:
        return True
    return False if b"did not match any file" in result.stderr else None


def remove_empty_parents(upstream, path):
    parent = os.path.dirname(path)
    while os.path.abspath(parent) != os.path.abspath(upstream):
        try:
            os.rmdir(parent)
        except OSError:
            return
        parent = os.path.dirname(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("additions")
    parser.add_argument("upstream")
    parser.add_argument("--exclude", action="append", default=[])
    args = parser.parse_args()
    additions = os.path.abspath(args.additions)
    upstream = os.path.abspath(args.upstream)
    if not os.path.isdir(additions) or not os.path.isdir(upstream):
        print("[sync-additions] additions or upstream directory missing", file=sys.stderr)
        return 1

    patterns = DEFAULT_EXCLUDES + args.exclude
    files = wanted_files(additions, patterns)
    copied = unchanged = 0
    for rel in files:
        source = os.path.join(additions, *rel.split("/"))
        target = os.path.join(upstream, *rel.split("/"))
        if os.path.isfile(target) and filecmp.cmp(source, target, shallow=False):
            unchanged += 1
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
        shutil.copymode(source, target)
        copied += 1

    manifest_path = os.path.join(upstream, MANIFEST)
    previous = []
    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding="utf-8") as handle:
            previous = [line.strip() for line in handle if line.strip()]
    current = set(files)
    carried = []
    removed = restored = kept = 0
    for rel in previous:
        if rel in current:
            continue
        target = os.path.join(upstream, *rel.split("/"))
        if excluded(rel, patterns):
            if os.path.lexists(target):
                carried.append(rel)
            continue
        tracked = tracked_by_upstream(upstream, rel)
        if tracked:
            subprocess.run(["git", "--literal-pathspecs", "-C", upstream, "checkout", "--", rel], check=True)
            restored += 1
        elif tracked is False:
            if os.path.lexists(target):
                os.remove(target)
                remove_empty_parents(upstream, target)
            removed += 1
        else:
            print(f"[sync-additions] keep {rel}: upstream is not a git checkout, cannot tell whether it is an upstream file",
                  file=sys.stderr)
            kept += 1
            carried.append(rel)

    manifest = sorted(current.union(carried))
    if manifest != previous:
        with open(manifest_path + ".tmp", "w", encoding="utf-8") as handle:
            handle.write("".join(rel + "\n" for rel in manifest))
        os.replace(manifest_path + ".tmp", manifest_path)
    print(f"[sync-additions] {len(files)} files: {copied} copied, {unchanged} unchanged, "
          f"{removed} stale removed, {restored} restored from upstream" + (f", {kept} kept" if kept else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
