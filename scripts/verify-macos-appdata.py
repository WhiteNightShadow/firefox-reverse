"""Exercise the final Mac package in redirected roots with sandbox fault injection.

No application resources are changed. The test-only dylib redirects FSFindFolder;
Seatbelt denies real profile roots even if that redirect were to fail. This tests
native error handling, not the reporter's macOS 27 TCC installation.
"""
import argparse
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shlex
import socket
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wire", REPO / "scripts/verify-windows-package.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def registry(root, name):
    profile = root / "Profiles" / name
    profile.mkdir(parents=True)
    (root / "profiles.ini").write_text(f"[General]\nStartWithLastProfile=1\nVersion=2\n[Profile0]\nName={name}\nIsRelative=1\nPath=Profiles/{name}\nDefault=1\n")
    (profile / "user.js").write_text('user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("extensions.firefox-reverse.agent.model.custom", "fixture-model");\n')
    return profile


def run(app, fixture, dylib, label, *, deny=None, overrides=None, fail=False, fault=None, seed=False, dedicated=False):
    support = fixture / "support"
    cache = fixture / "cache"
    support.mkdir(exist_ok=True)
    cache.mkdir(exist_ok=True)
    sandbox = fixture / f"{label}.sb"
    rules = ['(version 1)', '(allow default)']
    # Protect both spellings/symlink resolution of the real roots.
    for parent in (Path.home() / "Library/Application Support", Path.home() / "Library/Caches"):
        for name in ("Firefox", "FirefoxReverse"):
            for path in {str(parent / name), str((parent / name).resolve())}:
                rules.append(f'(deny file-read* file-write* (subpath {json.dumps(path)}))')
    if deny:
        operation, path = deny
        rules.append(f'(deny {operation} (subpath {json.dumps(str(path))}))')
    sandbox.write_text("\n".join(rules) + "\n")
    denial_confirmed = False
    if deny and "file-read*" in deny[0] and deny[1].exists():
        probe = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(sandbox), "/usr/bin/stat", "-f", "%HT", str(deny[1])], capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"})
        assert probe.returncode != 0 and any(message in probe.stderr for message in ("Operation not permitted", "Permission denied")), probe
        denial_confirmed = True
    env = {k: v for k, v in os.environ.items() if not k.startswith(("MOZ_", "XRE_", "FRX_", "DYLD_"))}
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    env.update(MOZ_LEGACY_PROFILES="1", MOZ_MARIONETTE="1",
               MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS=json.dumps({"marionette.port": port}))
    # Seatbelt does not support installing Firefox's child sandbox inside this
    # outer fault-injection sandbox. Only the owned fixture suppresses nesting;
    # ordinary package regression must run separately with normal sandboxes.
    for kind in ("CONTENT", "GPU", "RDD", "GMP", "SOCKET_PROCESS", "UTILITY", "VR"):
        env[f"MOZ_DISABLE_{kind}_SANDBOX"] = "1"
    if dedicated:
        env.pop("MOZ_LEGACY_PROFILES")
    env.update(overrides or {})
    injected = [f"DYLD_INSERT_LIBRARIES={dylib}", f"FRX_TEST_APPDATA_BASE={fixture}"]
    if fault:
        injected.append(f"FRX_TEST_MKDIR_ERRNO={fault}")
    command = ["/usr/bin/sandbox-exec", "-f", str(sandbox), "/usr/bin/env", *injected,
               str(app / "Contents/MacOS/firefox"), "-headless", "-new-instance",
               "-marionette", "-remote-allow-system-access", "about:blank"]
    connection = None
    wire = None
    result = {"case": label, "sandboxDenialConfirmed": denial_confirmed}
    log_path = fixture / f"{label}.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        try:
            if fail:
                try:
                    code = process.wait(timeout=8)
                    assert code != 0, f"{label}: error was silently ignored"
                except subprocess.TimeoutExpired:
                    # Early profile errors may present a modal even with
                    # -headless. A running process is not a successful launch.
                    try:
                        unexpected = socket.create_connection(("127.0.0.1", port), timeout=1)
                    except OSError:
                        pass
                    else:
                        unexpected.close()
                        raise AssertionError(f"{label}: unexpectedly reached Marionette")
                    result["errorProcessTerminatedByFixture"] = True
                result["startupBlockedAsExpected"] = True
            else:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    assert process.poll() is None, f"{label}: early exit: {log_path.read_text(errors='replace')[-2500:]}"
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                        break
                    except OSError:
                        time.sleep(0.15)
                assert connection, f"{label}: Marionette timeout"
                connection.settimeout(30)
                wire = native.Wire(connection)
                wire.read()
                wire.command("WebDriver:NewSession", {})
                wire.command("Marionette:SetContext", {"value": "chrome"})
                script = """
                  return {appData:Services.dirsvc.get('UAppData',Ci.nsIFile).path,
                    localData:Services.dirsvc.get('DefProfLRt',Ci.nsIFile).parent.path,
                    profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path,
                    model:ChromeUtils.importESModule('resource:///modules/agentsidebar/ConfigStore.sys.mjs').configStore.getModel('custom'),
                    saved:Services.prefs.getStringPref('frx.fixture.persisted',''),
                    build:Services.appinfo.appBuildID};
                """
                result.update(wire.command("WebDriver:ExecuteScript", {"script": script, "args": []})["value"])
                assert Path(result["profile"]).is_relative_to(fixture), "Fixture escaped its isolated roots"
                if seed:
                    code = """
                    const done=arguments[arguments.length-1];
                    (async()=>{const {PlacesUtils}=ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
                    await PlacesUtils.bookmarks.insert({parentGuid:PlacesUtils.bookmarks.unfiledGuid,url:'https://example.invalid/frx-issue18',title:'Issue 18 retained bookmark'});
                    ChromeUtils.importESModule('resource:///modules/agentsidebar/ConfigStore.sys.mjs').configStore.setModel('custom','fixture-model');
                    Services.prefs.setStringPref('frx.fixture.persisted','retained');Services.prefs.savePrefFile(null);return true;})().then(done,e=>done({error:String(e)}));
                    """
                    saved = wire.command("WebDriver:ExecuteAsyncScript", {"script": code, "args": [], "scriptTimeout": 20000})["value"]
                    assert saved is True, saved
                else:
                    code = """
                    const done=arguments[arguments.length-1];
                    (async()=>{const {PlacesUtils}=ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
                    return !!(await PlacesUtils.bookmarks.fetch({url:'https://example.invalid/frx-issue18'}));})().then(done,e=>done({error:String(e)}));
                    """
                    result["bookmarkRetained"] = wire.command("WebDriver:ExecuteAsyncScript", {"script": code, "args": [], "scriptTimeout": 20000})["value"]
                wire.command("Marionette:Quit", {"flags": ["eForceQuit"]})
                assert process.wait(timeout=20) == 0
        finally:
            if connection:
                connection.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
    text = log_path.read_text(errors="replace")
    assert "FRX_TEST_APPDATA: redirected" in text, "Home redirect was not loaded"
    if fault:
        assert f"mkdir errno={fault}" in text, "Fault injection did not execute"
    result["exitCode"] = process.returncode
    result["recoveryLogged"] = "using independent macOS app-data directory" in text
    result["legacyCreateDenied"] = "FRX_TEST_APPDATA: legacy mkdir denied=" in text
    if fail:
        result["errorEvidence"] = [line for line in text.splitlines() if line.startswith(("FRX_TEST_APPDATA:", "Firefox Reverse:", "Error:"))][-12:]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--xul-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline-smoke", action="store_true")
    parser.add_argument("--baseline", action="store_true", help="Expect v0.26.1 to fail when legacy app data is denied despite a working private profile")
    args = parser.parse_args()
    assert platform.system() == "Darwin"
    app = args.app.resolve()
    assert native.sha(app / "Contents/MacOS/XUL") == args.xul_sha256
    results = []
    with tempfile.TemporaryDirectory(prefix="frx-mac-appdata-") as temporary:
        root = Path(temporary).resolve()
        dylib = root / "home-fixture.dylib"
        subprocess.run([*shlex.split(os.environ.get("CC", "cc")), "-dynamiclib", "-Wno-deprecated-declarations", "-framework", "CoreServices", str(REPO / "scripts/tests/macos-appdata-home.c"), "-o", str(dylib)], check=True)

        def fixture(name):
            folder = root / name
            (folder / "support").mkdir(parents=True)
            (folder / "cache").mkdir()
            return folder

        old = fixture("old")
        legacy_profile = registry(old / "support/Firefox", "legacy")
        registry(old / "support/FirefoxReverse", "independent")
        result = run(app, old, dylib, "healthy-legacy")
        assert Path(result["profile"]) == legacy_profile
        assert not (old / "support/FirefoxReverse/.frx-appdata-v1").exists()
        results.append(result)

        owned = fixture("independent")
        private = owned / "support/FirefoxReverse"
        private.mkdir()
        explicit = {"MOZ_APP_DATA": str(private), "MOZ_LOCAL_APP_DATA": str(owned / "cache/explicit")}
        result = run(app, owned, dylib, "workaround-seed", overrides=explicit, seed=True, dedicated=True)
        profile = Path(result["profile"])
        assert profile.is_relative_to(private) and Path(result["localData"]) == owned / "cache/explicit"
        assert (private / "installs.ini").is_file(), "Real dedicated-profile mapping was not created"
        results.append(result)
        if args.baseline:
            denied = owned / "support/Firefox"
            denied.mkdir()
            result = run(app, owned, dylib, "baseline-denied-legacy", deny=("file-read* file-write*", denied), fail=True, dedicated=True)
            assert result["sandboxDenialConfirmed"] and not (private / ".frx-appdata-v1").exists()
            results.append(result)
        elif not args.baseline_smoke:
            denied = owned / "support/Firefox"
            denied.mkdir()
            result = run(app, owned, dylib, "resume-existing-private", deny=("file-read* file-write*", denied), dedicated=True)
            assert Path(result["profile"]) == profile and result["recoveryLogged"]
            assert result["saved"] == "retained" and result["model"] == "fixture-model" and result["bookmarkRetained"] is True
            assert Path(result["localData"]) == owned / "cache/FirefoxReverse"
            assert (private / ".frx-appdata-v1").is_file()
            results.append(result)
            registry(denied, "other-legacy")
            result = run(app, owned, dylib, "sticky-restart", dedicated=True)
            assert Path(result["profile"]) == profile and result["bookmarkRetained"] is True and result["saved"] == "retained"
            results.append(result)
            result = run(app, owned, dylib, "explicit-root-wins", overrides={"MOZ_APP_DATA": str(denied), "MOZ_LOCAL_APP_DATA": str(owned / "cache/override")})
            assert Path(result["profile"]) == denied / "Profiles/other-legacy"
            assert Path(result["localData"]) == owned / "cache/override"
            results.append(result)

            first_run = fixture("first-run")
            result = run(app, first_run, dylib, "healthy-first-run", dedicated=True)
            assert Path(result["appData"]) == first_run / "support/Firefox"
            assert not (first_run / "support/FirefoxReverse").exists()
            results.append(result)

            blocked_ini = fixture("blocked-ini")
            registry(blocked_ini / "support/Firefox", "legacy")
            preserved = registry(blocked_ini / "support/FirefoxReverse", "preserved")
            ini = blocked_ini / "support/Firefox/profiles.ini"
            before = ini.read_bytes()
            result = run(app, blocked_ini, dylib, "registry-read-denied", deny=("file-read*", ini))
            assert Path(result["profile"]) == preserved and result["recoveryLogged"]
            assert ini.read_bytes() == before, "Denied legacy registry was rewritten"
            results.append(result)

            fresh = fixture("fresh")
            result = run(app, fresh, dylib, "known-missing-create-denied", deny=("file-write-create", fresh / "support/Firefox"))
            assert Path(result["appData"]) == fresh / "support/FirefoxReverse" and result["recoveryLogged"]
            results.append(result)

            for name, fault in (("disk-full", errno.ENOSPC), ("io-failure", errno.EIO), ("read-only", errno.EROFS), ("unknown-legacy", None), ("legacy-file", None), ("invalid-private", None), ("denied-explicit", None)):
                folder = fixture(name)
                legacy = folder / "support/Firefox"
                alternate = folder / "support/FirefoxReverse"
                deny = None
                overrides = None
                if name in ("unknown-legacy", "invalid-private", "denied-explicit"):
                    legacy.mkdir()
                    deny = ("file-read* file-write*", legacy)
                if name == "legacy-file":
                    legacy.write_text("retain-file")
                if name == "invalid-private":
                    alternate.mkdir()
                    (alternate / "profiles.ini").write_text("not-a-registry")
                if name == "denied-explicit":
                    registry(alternate, "unused")
                    overrides = {"MOZ_APP_DATA": str(legacy)}
                    deny = ("file-read* file-write*", legacy)
                result = run(app, folder, dylib, name, deny=deny, overrides=overrides, fail=True, fault=fault)
                assert not (alternate / ".frx-appdata-v1").exists() and not result["recoveryLogged"]
                if name in ("disk-full", "io-failure", "read-only", "unknown-legacy", "legacy-file"):
                    assert not alternate.exists(), "Failure created an empty independent root"
                if name == "legacy-file":
                    assert legacy.read_text() == "retain-file"
                if name == "invalid-private":
                    assert (alternate / "profiles.ini").read_text() == "not-a-registry"
                results.append(result)
        # Reports omit temporary absolute paths and contain no user profile data.
        results = json.loads(json.dumps(results).replace(str(root), "$FIXTURE"))
    assert native.sha(app / "Contents/MacOS/XUL") == args.xul_sha256, "Application changed during verification"
    report = {"status": "passed", "systemVersion": platform.mac_ver()[0], "xulSHA256": args.xul_sha256, "baselineSmoke": args.baseline_smoke, "baseline": args.baseline, "checks": results, "limitations": ["Temporary FSFindFolder redirect and sandbox faults, not macOS 27 TCC reproduction.", "Child sandbox nesting is suppressed only in this fixture; run normal-sandbox Agent/page/fingerprint regression separately.", "Final application resources are unmodified; the test-only dylib is not distributed."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
