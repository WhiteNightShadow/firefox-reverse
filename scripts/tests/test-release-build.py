"""release-build.sh: the mozconfig a release build uses, the checks that run before any build work, and the
activate/build flow against a stub mach and stub helper scripts."""
from pathlib import Path
import hashlib
import os
import shutil
import subprocess
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/release-build.sh"

# Configure options recorded in the v0.26.2 packages (about:buildconfig), without the build host's
# --with-l10n-base path. The macOS arm64 objdir was configured before --enable-bootstrap=no-update
# was spelled out; bootstrap was already on by default for that Nightly git checkout.
SHARED = {
    "--enable-bootstrap=no-update",
    "--enable-application=browser",
    "--with-branding=browser/branding/unofficial",
    "--enable-release",
    "--disable-crashreporter",
    "--disable-backgroundtasks",
    "--disable-tests",
    "--disable-updater",
}
RELEASED = {
    "macos-arm64": SHARED | {"--target=aarch64-apple-darwin"},
    "macos-x86_64": SHARED | {"--target=x86_64-apple-darwin"},
    "linux-x86_64": SHARED,
    "linux-arm64": SHARED | {"--target=aarch64-linux-gnu"},
    "windows-x86_64": SHARED | {"--target=x86_64-pc-windows-msvc", "--disable-default-browser-agent"},
}
OBJDIRS = {
    "macos-arm64": "obj-aarch64-apple-darwin",
    "macos-x86_64": "obj-x86_64-apple-darwin",
    "linux-x86_64": "obj-x86_64-linux",
    "linux-arm64": "obj-aarch64-linux",
    "windows-x86_64": "obj-win64",
}
BUILD_ID = {"MOZ_BUILD_DATE": "20261024082441"}


def commit_fixture(directory):
    git = ["git", "-C", str(directory), "-c", "user.name=test", "-c", "user.email=test@example.invalid",
           "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]
    subprocess.run(["git", "init", "-q", str(directory)], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "fixture"], check=True)
    return subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()


def write_executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


# Records each call; on `build` it writes the application.ini a real build would produce.
STUB_MACH = """#!/usr/bin/env python3
import os, pathlib, re, sys
with open(os.environ["FRX_TEST_LOG"], "a") as log:
    log.write("mach " + " ".join(sys.argv[1:]) + "\\n")
config = pathlib.Path(os.environ["MOZCONFIG"]).read_text()
objdir = pathlib.Path(re.search(r"^mk_add_options MOZ_OBJDIR=(.+)$", config, re.M).group(1))
if sys.argv[1] == "build":
    (objdir / "dist/bin").mkdir(parents=True, exist_ok=True)
    (objdir / "dist/bin/application.ini").write_text(
        "[App]\\nBuildID=%s\\nSourceStamp=%s\\n" % (os.environ["MOZ_BUILD_DATE"], os.environ["MOZ_SOURCE_CHANGESET"]))
"""

# Stands in for scripts/repack-zh-cn.sh: every package kind lands in dist with a clearly newer mtime.
STUB_REPACK = """#!/usr/bin/env bash
set -euo pipefail
echo "repack-zh-cn $UPSTREAM_DIR" >> "$FRX_TEST_LOG"
[[ -z "${FRX_TEST_REPACK_NOTHING:-}" ]] || exit 0
python3 - "$(sed -n 's/^mk_add_options MOZ_OBJDIR=//p' "$MOZCONFIG")" <<'PY'
import os, pathlib, sys, time
dist = pathlib.Path(sys.argv[1]) / "dist"
dist.mkdir(parents=True, exist_ok=True)
for kind in ("mac.dmg", "linux-x86_64.tar.xz", "linux-aarch64.tar.xz", "win64.zip", "win64.installer.exe",
             "win64.xpt_artifacts.zip"):
    path = dist / f"firefox-153.0a1.en-US.{kind}"
    path.write_text(f"{kind} {os.environ['MOZ_BUILD_DATE']}\\n")
    os.utime(path, (time.time() + 5, time.time() + 5))
PY
"""


def logging_stub(name, language):
    if language == "python":
        return f"import os, sys\nopen(os.environ['FRX_TEST_LOG'], 'a').write('{name} ' + ' '.join(sys.argv[1:]) + '\\n')\n"
    if language == "node":
        return f"import fs from 'node:fs';\nfs.appendFileSync(process.env.FRX_TEST_LOG, '{name} ' + process.argv.slice(2).join(' ') + '\\n');\n"
    return f"#!/usr/bin/env bash\necho \"{name} $*\" >> \"$FRX_TEST_LOG\"\n"


class ReleaseBuildTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frx-release-build-test-")
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.l10n = self.root / "l10n"
        self.upstream.mkdir()
        (self.l10n / "zh-CN").mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args, **overrides):
        env = {key: value for key, value in os.environ.items() if not key.startswith(("FRX_", "MOZ_", "UPSTREAM_"))}
        env.update(UPSTREAM_DIR=str(self.upstream), FRX_L10N_BASE=str(self.l10n), **overrides)
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, encoding="utf-8")

    def test_mozconfig_matches_the_released_packages(self):
        for target, expected in RELEASED.items():
            with self.subTest(target=target):
                result = self.run_script("mozconfig", target)
                self.assertEqual(result.returncode, 0, result.stderr)
                lines = result.stdout.splitlines()
                options = {line.split(" ", 1)[1] for line in lines if line.startswith("ac_add_options ")}
                self.assertEqual(options, expected | {f"--with-l10n-base={self.l10n}"})
                self.assertEqual([line for line in lines if "MOZ_OBJDIR" in line],
                                 [f"mk_add_options MOZ_OBJDIR={self.upstream}/{OBJDIRS[target]}"])

    def test_objdir_override_must_be_absolute(self):
        objdir = self.root / "objdirs" / "mac"
        result = self.run_script("mozconfig", "macos-arm64", FRX_OBJDIR=f"{objdir}/")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"mk_add_options MOZ_OBJDIR={objdir}\n", result.stdout)
        result = self.run_script("mozconfig", "macos-arm64", FRX_OBJDIR="objdirs/mac")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FRX_OBJDIR", result.stderr)

    def test_unknown_target_is_rejected(self):
        for args in (("mozconfig", "macos"), ("build", "win-x64"), ("build",)):
            with self.subTest(args=args):
                result = self.run_script(*args, **BUILD_ID)
                self.assertEqual(result.returncode, 2)
                self.assertIn("targets:", result.stderr)

    def test_build_needs_one_shared_build_id(self):
        for overrides in ({}, {"MOZ_BUILD_DATE": "2026-10-24"}, {"MOZ_BUILD_DATE": "202610240824"}):
            with self.subTest(overrides=overrides):
                result = self.run_script("build", "linux-x86_64", **overrides)
                self.assertEqual(result.returncode, 1)
                self.assertIn("MOZ_BUILD_DATE", result.stderr)

    def test_build_refuses_sources_off_the_pins(self):
        (self.upstream / "mach").write_text("#!/bin/sh\nexit 99\n")
        (self.upstream / "mach").chmod(0o755)
        baseline = commit_fixture(self.upstream)
        translations = commit_fixture(self.l10n)

        result = self.run_script("build", "linux-x86_64", **BUILD_ID)
        self.assertEqual(result.returncode, 1)
        self.assertIn("不是锁定基线", result.stderr)

        result = self.run_script("build", "linux-x86_64", UPSTREAM_REF=baseline, **BUILD_ID)
        self.assertEqual(result.returncode, 1)
        self.assertIn("l10n 检出的 HEAD", result.stderr)

        (self.l10n / "zh-CN" / "browser.ftl").write_text("changed = 1\n")
        result = self.run_script("build", "linux-x86_64", UPSTREAM_REF=baseline, FRX_L10N_REF=translations, **BUILD_ID)
        self.assertEqual(result.returncode, 1)
        self.assertIn("l10n 检出有改动", result.stderr)


@unittest.skipUnless(shutil.which("sha256sum") and shutil.which("node"), "needs sha256sum and node")
class ReleaseBuildFlowTest(unittest.TestCase):
    """A copy of the script in a throwaway repository, with mach and the helper scripts replaced by stubs."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frx-release-flow-test-")
        root = Path(self.temp.name)
        self.repo, self.upstream, self.l10n, self.bin = root / "repo", root / "upstream", root / "l10n", root / "bin"
        self.log = root / "calls.log"

        shutil.copytree(REPO / "configs", self.repo / "configs")
        write_executable(self.repo / "scripts/release-build.sh", SCRIPT.read_text())
        write_executable(self.repo / "scripts/repack-zh-cn.sh", STUB_REPACK)
        for name, language in (("selftest-agent-tools.sh", "bash"), ("apply-patches.sh", "bash"),
                               ("force-build-id-relink.sh", "bash"), ("verify-linux-package.sh", "bash"),
                               ("verify-branding.py", "python"), ("verify-windows-installer.py", "python"),
                               ("check-branding-assets.mjs", "node")):
            write_executable(self.repo / "scripts" / name, logging_stub(name, language))
        prefs = self.repo / "additions/browser/components/agent-sidebar/preferences/frx-locale.js"
        prefs.parent.mkdir(parents=True)
        prefs.write_text('pref("extensions.firefox-reverse.version", "9.8.7");\n')
        self.commit = commit_fixture(self.repo)

        write_executable(self.upstream / "mach", STUB_MACH)
        self.baseline = commit_fixture(self.upstream)
        (self.l10n / "zh-CN").mkdir(parents=True)
        (self.l10n / "zh-CN/browser.ftl").write_text("brand = 1\n")
        self.translations = commit_fixture(self.l10n)

        write_executable(self.bin / "npm", logging_stub("npm", "bash"))
        write_executable(self.bin / "7z", "#!/bin/sh\nexit 0\n")
        if not shutil.which("flock"):
            write_executable(self.bin / "flock", "#!/bin/sh\nexit 0\n")
        (root / "home").mkdir()
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("FRX_", "MOZ_", "UPSTREAM_"))}
        self.env.update(PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}", HOME=str(root / "home"),
                        FRX_TEST_LOG=str(self.log), UPSTREAM_DIR=str(self.upstream), FRX_L10N_BASE=str(self.l10n),
                        UPSTREAM_REF=self.baseline, FRX_L10N_REF=self.translations, **BUILD_ID)
        self.dist = self.repo / "dist/v9.8.7-candidate"

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args, **overrides):
        return subprocess.run(["bash", str(self.repo / "scripts/release-build.sh"), *args],
                              env={**self.env, **overrides}, capture_output=True, encoding="utf-8")

    def calls(self):
        calls = [line.split(" ", 1)[0] for line in self.log.read_text().splitlines()] if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return calls

    def test_build_refuses_a_tree_activated_for_another_commit(self):
        result = self.run_script("build", "linux-x86_64")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"不是按 {self.commit} 激活的", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_activate_then_build_collects_only_the_new_packages(self):
        result = self.run_script("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"ACTIVATED {self.commit}", result.stdout)
        self.assertEqual((self.upstream / ".frx-release-applied").read_text(), self.commit + "\n")
        self.assertEqual(self.calls(), ["npm", "selftest-agent-tools.sh", "apply-patches.sh", "check-branding-assets.mjs"])

        stale = self.upstream / "obj-x86_64-linux/dist/firefox-153.0a0.en-US.linux-x86_64.tar.xz"
        stale.parent.mkdir(parents=True)
        stale.write_text("previous release\n")
        os.utime(stale, (time.time() - 3600, time.time() - 3600))
        result = self.run_script("build", "linux-x86_64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), ["mach", "verify-branding.py", "force-build-id-relink.sh", "mach", "repack-zh-cn",
                                        "verify-linux-package.sh"])
        package = self.dist / "firefox-reverse-v9.8.7-linux-x86_64.tar.xz"
        self.assertEqual(package.read_text(), "linux-x86_64.tar.xz 20261024082441\n")
        self.assertEqual((self.dist / "linux-x86_64.sha256").read_text(),
                         f"{hashlib.sha256(package.read_bytes()).hexdigest()}  {package.name}\n")
        self.assertIn(f"ac_add_options --with-l10n-base={self.l10n}\n", (self.dist / "mozconfig.linux-x86_64").read_text())
        self.assertIn(f"COMPLETE linux-x86_64 {self.commit} 20261024082441", result.stdout)

        result = self.run_script("build", "windows-x86_64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1], "verify-windows-installer.py")
        names = [line.split()[1] for line in (self.dist / "windows-x86_64.sha256").read_text().splitlines()]
        self.assertEqual(names, ["firefox-reverse-v9.8.7-windows-x86_64.zip",
                                 "firefox-reverse-v9.8.7-windows-x86_64-installer.exe"])
        self.assertEqual(list(self.upstream.glob("obj-*/.frx-package-start.*")), [])

    def test_build_fails_when_the_repack_produces_no_package(self):
        self.assertEqual(self.run_script("activate").returncode, 0)
        result = self.run_script("build", "macos-arm64", FRX_TEST_REPACK_NOTHING="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("firefox-*.mac.dmg，实际有 0 个", result.stderr)
        self.assertFalse((self.dist / "firefox-reverse-v9.8.7-macos-arm64.dmg").exists())


if __name__ == "__main__":
    unittest.main()
