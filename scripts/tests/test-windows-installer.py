"""verify-windows-installer.py: the installer's core/ payload must equal the ZIP's firefox/ tree file for file."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/verify-windows-installer.py"

# Stands in for 7-Zip: the test "installer" is a ZIP, and `x -y -o<dir> <archive> core` unpacks its core/ entries.
FAKE_SEVEN_ZIP = """#!/usr/bin/env python3
import sys, zipfile
args = sys.argv[1:]
assert args[:2] == ["x", "-y"] and args[2].startswith("-o") and args[4] == "core", args
with zipfile.ZipFile(args[3]) as archive:
    archive.extractall(args[2][2:], [name for name in archive.namelist() if name.startswith("core/")])
"""

PAYLOAD = {
    "firefox.exe": b"MZ launcher",
    "xul.dll": b"MZ engine",
    "application.ini": b"[App]\nBuildID=20261024082441\n",
    "browser/omni.ja": b"browser omni",
}


def write_zip(path, prefix, files):
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(prefix + name, data)


class WindowsInstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frx-installer-test-")
        self.root = Path(self.temp.name)
        self.seven_zip = self.root / "fake-7zz"
        self.seven_zip.write_text(FAKE_SEVEN_ZIP)
        os.chmod(self.seven_zip, 0o755)
        self.portable = self.root / "portable.zip"
        write_zip(self.portable, "firefox/", PAYLOAD)

    def tearDown(self):
        self.temp.cleanup()

    def run_check(self, installer_files, core=True):
        installer = self.root / "installer.exe"
        write_zip(installer, "core/" if core else "other/", installer_files)
        report = self.root / "report.json"
        result = subprocess.run([sys.executable, str(SCRIPT), "--installer", str(installer), "--zip", str(self.portable),
                                 "--seven-zip", str(self.seven_zip), "--output", str(report)], capture_output=True, text=True)
        return result, (json.loads(report.read_text()) if report.exists() else None)

    def test_identical_payload_passes(self):
        result, report = self.run_check(PAYLOAD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["status"], "passed")
        self.assertEqual((report["files"], report["matched"]), (4, 4))
        self.assertIn("not executed", report["mode"])

    def test_changed_file_fails(self):
        result, report = self.run_check({**PAYLOAD, "xul.dll": b"MZ other engine"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["mismatched"], ["xul.dll"])

    def test_extra_and_missing_files_fail(self):
        files = {name: data for name, data in PAYLOAD.items() if name != "browser/omni.ja"}
        result, report = self.run_check({**files, "distribution/policies.json": b"{}"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["onlyInInstaller"], ["distribution/policies.json"])
        self.assertEqual(report["onlyInZip"], ["browser/omni.ja"])

    def test_installer_without_core_is_rejected(self):
        result, report = self.run_check(PAYLOAD, core=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no core/ payload", result.stderr)
        self.assertIsNone(report)


if __name__ == "__main__":
    unittest.main()
