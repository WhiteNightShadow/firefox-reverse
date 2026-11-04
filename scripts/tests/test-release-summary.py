"""release-summary.py and release-reports.py on synthetic report directories, plus the argument checks of the
acceptance scripts (those need no browser)."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SUMMARY = REPO / "scripts/release-summary.py"
REPORTS = REPO / "scripts/release-reports.py"
COMMIT = "a" * 40
BUILD_ID = "20261102031948"
PROFILE_NAME = "abcd1234.default-release"  # must never reach the summary


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    return path


def native_reports(directory, fingerprint=212, build_id=BUILD_ID, modules=43, arch="x86_64", identity=True):
    d = Path(directory)
    if identity:
        write(d / "PACKAGE-IDENTITY.json", {"status": "passed", "sourceCommit": COMMIT, "buildID": build_id, "modules": ["M"] * modules, "binaryArchitecture": arch})
    write(d / "PAGE-REPORT.json", {"buildID": build_id, "checks": ["check"] * 78})
    write(d / "ENVIRONMENT-LIFECYCLE.json", {"status": "passed", "buildID": build_id, "scenarios": {
        "quit-channel": {"checks": [1] * 12}, "identity": {"checks": [1] * 9}, "restart": {"checks": [1] * 6}}})
    write(d / "FINGERPRINT-REPORT.json", {"passed": True, "checks": [{"passed": True}] * fingerprint})
    write(d / "global-system-prompt/report.json", {"status": "passed", "source_commit": COMMIT, "build_id": build_id, "checks": [1] * 8,
                                                   "requests": [1] * 11, "browser_exit_codes": [0, 0], "package_unchanged": True})
    return d


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        self.packages = [write(self.root / "packages" / f"firefox-reverse-v9.9.9-{n}", f"package {n}") for n in (
            "macos-arm64.dmg", "macos-x86_64.dmg", "windows-x86_64.zip", "windows-x86_64-installer.exe", "linux-x86_64.tar.xz", "linux-arm64.tar.xz")]
        ci = self.root / "ci"
        for target, count, arch in (("windows-x86_64", 212, "x86_64"), ("linux-x86_64", 182, "x86_64"), ("linux-arm64", 182, "arm64"), ("macos-x86_64", 197, "x86_64")):
            native_reports(ci / f"native-{target}-report", count, arch=arch)
        write(ci / "windows-native-report/WINDOWS-NATIVE-REPORT.json", {"status": "passed", "source_commit": COMMIT, "runtime_build_id": BUILD_ID,
                                                                         "screenshot_runs": [1] * 6, "ledger_checks": [1] * 5, "msvc_runtime": ["vcruntime140.dll"]})
        mac = native_reports(self.root / "mac", 213, arch="arm64")
        write(mac / "MACOS-APPDATA.json", {"status": "passed", "checks": [1] * 15})
        write(mac / "acceptance.json", {"status": "passed", "packageAfterRun": {"codesign": "passed", "xulUnchanged": True, "leftoverBrowserProcesses": 0}})
        win = native_reports(self.root / "win", 212, identity=False)  # older layout: identity only in the prepare log
        write(win / "windows-native-report/windows-native-report.json", {"status": "passed", "source_commit": COMMIT, "runtime_build_id": BUILD_ID,
                                                                         "screenshot_runs": [1] * 6, "ledger_checks": [1] * 5, "msvc_runtime": ["msvcp140.dll"]})
        write(win / "candidate.log", "unpacking...\n" + json.dumps({"status": "passed", "sourceCommit": COMMIT, "buildID": BUILD_ID, "modules": ["M"] * 43, "binaryArchitecture": "x86_64"}))
        app = {"profile": PROFILE_NAME, "buildID": BUILD_ID, "version": "9.9.9", "lastVersion": f"153.0a1_{BUILD_ID}/{BUILD_ID}"}
        counts = {"bookmarks": 1234, "modelProfiles": 3, "activeModelProfile": True, "environments": 7}
        write(self.root / "upgrade/baseline.json", {"status": "passed", "app": {**app, "buildID": "20261030041435"}, "before": counts})
        write(self.root / "upgrade/after.json", {"status": "passed", "app": app, "before": counts, "after": counts,
                                                  "temporaryEnvironment": {"closedBy": "quit-channel"}, "checks": ["c"] * 9})
        write(self.root / "installer.json", {"status": "passed", "files": 54, "matched": 54})
        self.spec = {
            "version": "9.9.9", "sourceCommit": COMMIT, "buildID": BUILD_ID,
            "packages": [str(p) for p in self.packages],
            "nativeCI": {"run": "https://example.invalid/runs/1", "mcpCommit": "b" * 40, "artifacts": str(ci)},
            "buildHost": "a test machine",
            "local": [
                {"target": "macos-arm64", "host": "macOS arm64", "signature": "ad-hoc", "reports": str(mac)},
                {"target": "windows-x86_64", "host": "Windows x64 VM", "reports": str(win), "prepareLog": str(win / "candidate.log")},
                {"target": "windows-x86_64", "host": "Windows arm64 VM", "reports": str(win), "prepareLog": str(win / "candidate.log")},
            ],
            "windowsInstallerCheck": str(self.root / "installer.json"),
            "inPlaceUpgrade": {"target": "macos-arm64", "from": "old", "baseline": str(self.root / "upgrade/baseline.json"), "after": str(self.root / "upgrade/after.json")},
            "limitations": ["synthetic"],
        }

    def run(self, spec=None):
        spec_path = write(self.root / "spec.json", spec or self.spec)
        output = self.root / "summary.json"
        result = subprocess.run([sys.executable, str(SUMMARY), str(spec_path), str(output)], capture_output=True, text=True)
        return result, json.loads(output.read_text(encoding="utf-8")) if output.exists() else None


class ReleaseSummaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_complete_release(self):
        result, summary = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(summary["status"], "passed")
        self.assertEqual(len(summary["packages"]), 6)
        ci = summary["nativeCI"]["results"]
        self.assertEqual({t: r["nativeFingerprintAssertions"] for t, r in ci.items()},
                         {"windows-x86_64": 212, "linux-x86_64": 182, "linux-arm64": 182, "macos-x86_64": 197})
        self.assertEqual(ci["windows-x86_64"]["windowsPackage"]["screenshotRuns"], 6)
        self.assertEqual(ci["linux-arm64"]["packageIdentity"], "passed (43 sidebar modules, arm64)")
        mac = summary["local"]["macos-arm64"]
        self.assertEqual(mac["checks"]["environmentLifecycle"], {"quit-channel": 12, "identity": 9, "restart": 6})
        self.assertEqual(mac["macOSAppDataNativeScenarios"], 15)
        self.assertEqual(mac["packageAfterRun"]["codesign"], "passed")
        self.assertEqual(len(summary["local"]["windows-x86_64"]), 2, "two runs of one target become a list")
        self.assertEqual(summary["local"]["windows-x86_64"][0]["packageIdentity"], "passed (43 sidebar modules, x86_64)")
        upgrade = mac["inPlaceUpgradeFromold"]
        self.assertTrue(upgrade["sameProfile"] and upgrade["runningRelease"] and upgrade["bookmarksModelProfilesEnvironmentsUnchanged"])
        self.assertIn("54 files", summary["local"]["windows-installer"])

    def test_no_personal_data(self):
        _, summary = self.fx.run()
        text = json.dumps(summary)
        self.assertNotIn(PROFILE_NAME, text)
        self.assertNotIn("1234", text, "bookmark counts stay out of the summary")

    def test_failed_check_makes_it_incomplete(self):
        native_reports(Path(self.fx.spec["nativeCI"]["artifacts"]) / "native-linux-arm64-report", 182, arch="arm64")
        write(Path(self.fx.spec["nativeCI"]["artifacts"]) / "native-linux-arm64-report/FINGERPRINT-REPORT.json",
              {"passed": False, "checks": [{"passed": True}, {"passed": False}]})
        result, summary = self.fx.run()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary["status"], "incomplete")
        self.assertEqual(summary["nativeCI"]["results"]["linux-arm64"]["status"], "failed")
        self.assertTrue(any("native CI linux-arm64" in p and "fingerprint" in p for p in summary["pending"]))

    def test_missing_report_and_other_build(self):
        (Path(self.fx.spec["nativeCI"]["artifacts"]) / "native-macos-x86_64-report/PAGE-REPORT.json").unlink()
        native_reports(Path(self.fx.spec["nativeCI"]["artifacts"]) / "native-linux-x86_64-report", 182, build_id="20990101000000")
        _, summary = self.fx.run()
        pending = "\n".join(summary["pending"])
        self.assertIn("native CI macos-x86_64: missing page-interaction", pending)
        self.assertIn("native CI linux-x86_64", pending, "reports of another build do not count")

    def test_missing_package_and_upgrade(self):
        spec = dict(self.fx.spec, packages=self.fx.spec["packages"][:5])
        spec["inPlaceUpgrade"] = dict(spec["inPlaceUpgrade"], after=str(self.fx.root / "nowhere.json"))
        _, summary = self.fx.run(spec)
        pending = "\n".join(summary["pending"])
        self.assertIn("expected six packages, have 5", pending)
        self.assertIn("in-place upgrade reports", pending)


class AcceptanceReportTest(unittest.TestCase):
    def run_acceptance(self, directory, *extra):
        return subprocess.run([sys.executable, str(REPORTS), "acceptance", "--dir", str(directory), "--target", "linux-arm64",
                               "--package", "p.tar.xz", "--sha256", "0" * 64, "--commit", COMMIT, "--build-id", BUILD_ID, *extra],
                              capture_output=True, text=True)

    def test_passing_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            native_reports(tmp, 182, arch="arm64")
            steps = [f"--step={n}=passed" for n in ("package-identity", "page-interaction", "lifecycle", "fingerprint", "global-prompt")]
            result = self.run_acceptance(tmp, *steps, "--xul-unchanged", "true", "--leftover", "0", "--host", "test host")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((Path(tmp) / "acceptance.json").read_text())
            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["counts"]["nativeFingerprintAssertions"], 182)
            self.assertEqual(report["host"], "test host")

    def test_step_without_report_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            native_reports(tmp, 182)
            (Path(tmp) / "FINGERPRINT-REPORT.json").unlink()
            result = self.run_acceptance(tmp, "--step", "fingerprint=passed", "--xul-unchanged", "true", "--leftover", "0")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads((Path(tmp) / "acceptance.json").read_text())["missingReports"], ["fingerprint"])

    def test_changed_package_or_leftover_browser_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            native_reports(tmp, 182)
            self.assertEqual(self.run_acceptance(tmp, "--step", "lifecycle=passed", "--xul-unchanged", "false", "--leftover", "0").returncode, 1)
            self.assertEqual(self.run_acceptance(tmp, "--step", "lifecycle=passed", "--xul-unchanged", "true", "--leftover", "2").returncode, 1)
            self.assertEqual(self.run_acceptance(tmp, "--step", "lifecycle=passed", "--codesign", "failed", "--xul-unchanged", "true", "--leftover", "0").returncode, 1)


class AcceptanceScriptArgumentsTest(unittest.TestCase):
    def test_release_accept_rejects_bad_input(self):
        script = REPO / "scripts/release-accept.sh"
        self.assertEqual(subprocess.run(["bash", str(script)], capture_output=True).returncode, 2, "usage without arguments")
        with tempfile.TemporaryDirectory() as tmp:
            target = "macos-arm64" if sys.platform == "darwin" else "linux-arm64" if Path("/proc/cpuinfo").exists() and "aarch64" in subprocess.run(["uname", "-m"], capture_output=True, text=True).stdout else "linux-x86_64"
            ext = "dmg" if target.startswith("macos") else "tar.xz"
            package = write(Path(tmp) / f"wrong-name.{ext}", "x")
            result = subprocess.run(["bash", str(script), "--package", str(package), "--target", target, "--commit", COMMIT, "--build-id", BUILD_ID,
                                     "--mcp-root", tmp, "--out", str(Path(tmp) / "out")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("package name must be firefox-reverse-<tag>-", result.stderr)

    def test_windows_vm_rejects_bad_input(self):
        script = REPO / "scripts/release-accept-windows-vm.sh"
        self.assertEqual(subprocess.run(["bash", str(script)], capture_output=True).returncode, 2, "usage without arguments")
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = write(Path(tmp) / "firefox-reverse-v9.9.9-linux-x86_64.zip", "x")
            result = subprocess.run(["bash", str(script), "--ssh", "user@host", "--zip", str(zip_path), "--commit", COMMIT, "--build-id", BUILD_ID,
                                     "--mcp-root", tmp, "--out", str(Path(tmp) / "out")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("ZIP name must be firefox-reverse-<tag>-windows-x86_64.zip", result.stderr)

    def test_windows_script_is_ascii(self):
        # Windows PowerShell 5.1 reads a script without BOM in the system code page.
        self.assertTrue((REPO / "scripts/release-accept-windows.ps1").read_text(encoding="utf-8").isascii())


if __name__ == "__main__":
    unittest.main()
