"""Extract and bind a downloaded release candidate before native CI execution."""
import configparser
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import zipfile


def sha(filename):
    with Path(filename).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


tag = os.environ["RELEASE_TAG"]
target = os.environ["PACKAGE_TARGET"]
commit = os.environ["SOURCE_COMMIT"]
build_id = os.environ["EXPECTED_BUILD_ID"]
checksums = json.loads(os.environ["PACKAGE_CHECKSUMS"])
suffix = ".zip" if target.startswith("windows") else ".dmg" if target.startswith("macos") else ".tar.xz"
name = f"firefox-reverse-{tag}-{target}{suffix}"
package = Path("candidate") / name
assert sha(package) == checksums[name], "candidate package checksum mismatch"
output = Path("native-report").resolve()
output.mkdir(exist_ok=True)
stage = Path("candidate-stage").resolve()
stage.mkdir(exist_ok=True)
if suffix == ".zip":
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        for entry in archive.namelist():
            assert (stage / entry).resolve().is_relative_to(stage), "unsafe ZIP path"
        archive.extractall(stage)
elif suffix == ".tar.xz":
    with tarfile.open(package) as archive:
        archive.extractall(stage, filter="data")
else:
    mount = plistlib.loads(subprocess.check_output(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(package)]))
    volume = next(Path(item["mount-point"]) for item in mount["system-entities"] if "mount-point" in item)
    try:
        app = next(volume.glob("*.app"))
        shutil.copytree(app, stage / app.name, symlinks=True)
    finally:
        subprocess.run(["hdiutil", "detach", str(volume)], check=True)

if suffix == ".dmg":
    binary = next(stage.glob("*.app"))
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(binary)], check=True)
    resource_root = binary / "Contents/Resources"
    xul = binary / "Contents/MacOS/XUL"
else:
    resource_root = stage / "firefox"
    binary = resource_root / ("firefox.exe" if target.startswith("windows") else "firefox")
    xul = resource_root / ("xul.dll" if target.startswith("windows") else "libxul.so")
ini = configparser.ConfigParser(interpolation=None)
ini.read(resource_root / "application.ini", encoding="utf-8")
assert ini["App"]["BuildID"] == build_id, "BuildID mismatch"
assert ini["App"]["SourceStamp"] == commit, "SourceStamp mismatch"
expected = subprocess.check_output(["git", "show", f"{commit}:additions/browser/components/agent-sidebar/preferences/frx-locale.js"])
preference_file = resource_root / "defaults/pref/frx-locale.js"
if preference_file.is_file():
    actual_preferences = preference_file.read_bytes()
else:
    with zipfile.ZipFile(resource_root / "omni.ja") as archive:
        actual_preferences = archive.read("defaults/pref/frx-locale.js")
assert actual_preferences == expected, "stale packaged locale/version preferences"
with zipfile.ZipFile(resource_root / "omni.ja") as archive:
    extension_parent = archive.read("modules/ExtensionParent.sys.mjs")
    assert b"#promiseWindowlessBrowserReady" in extension_parent
    assert b"#promiseXULFrameLoaderCreated" in extension_parent
    extension_parent_sha = hashlib.sha256(extension_parent).hexdigest()
assert tag[1:] in expected.decode()
modules = ["EnvironmentBackend", "NativeFingerprintPolicy", "ConfigStore", "SidebarTypography", "LlmClient"]
with zipfile.ZipFile(resource_root / "browser/omni.ja") as archive:
    ui_prefix = "chrome/browser/content/browser/agent-sidebar/"
    bundle_sha = hashlib.sha256(archive.read(ui_prefix + "agent-sidebar.bundle.js")).hexdigest()
    expected_css = subprocess.check_output(["git", "show", f"{commit}:additions/browser/components/agent-sidebar/content/agent-panel.css"])
    assert archive.read(ui_prefix + "agent-panel.css") == expected_css, "stale sidebar styles"
    for module in modules:
        expected = subprocess.check_output(["git", "show", f"{commit}:additions/browser/components/agent-sidebar/modules/{module}.sys.mjs"])
        assert archive.read(f"modules/agentsidebar/{module}.sys.mjs") == expected, f"stale module: {module}"
    assert "右击或下拉显示历史" in archive.read("localization/zh-CN/browser/browserContext.ftl").decode()
report = {"package": name, "packageSHA256": sha(package), "xulSHA256": sha(xul), "sidebarBundleSHA256": bundle_sha, "extensionParentSHA256": extension_parent_sha, "sourceCommit": commit, "buildID": build_id, "modules": modules, "status": "passed"}
(output / "PACKAGE-IDENTITY.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as stream:
    stream.write(f"FRX_TEST_BINARY={binary}\nFRX_TEST_XUL_SHA={report['xulSHA256']}\n")
print(json.dumps(report))
