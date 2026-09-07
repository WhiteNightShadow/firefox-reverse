"""Validate the exact candidate ZIP on a native Windows CI runner."""
import configparser
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import zipfile


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stop(process):
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        process.wait(timeout=15)


@contextmanager
def temporary_workspace():
    work = Path(tempfile.mkdtemp(prefix="frx-native-"))
    try:
        yield work
    finally:
        # Windows may briefly retain file locks after the browser exits.
        for attempt in range(20):
            try:
                shutil.rmtree(work)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(1)


class Wire:
    def __init__(self, connection):
        self.connection = connection
        self.counter = 0

    def read(self):
        header = bytearray()
        while True:
            char = self.connection.recv(1)
            if not char:
                raise RuntimeError("Marionette disconnected")
            if char == b":":
                break
            header.extend(char)
            if len(header) > 12:
                raise RuntimeError("Invalid Marionette frame")
        count = int(header)
        assert 0 <= count <= 10_000_000
        body = bytearray()
        while len(body) < count:
            part = self.connection.recv(count - len(body))
            if not part:
                raise RuntimeError("Truncated Marionette frame")
            body.extend(part)
        return json.loads(body)

    def command(self, name, params):
        self.counter += 1
        data = json.dumps([0, self.counter, name, params]).encode()
        self.connection.sendall(str(len(data)).encode() + b":" + data)
        while True:
            response = self.read()
            if isinstance(response, list) and response[:2] == [1, self.counter]:
                if response[2]:
                    raise RuntimeError(response[2])
                return response[3]


def validate(report, output):
    assert platform.system() == "Windows", "Native Windows is required"
    tag = os.environ["RELEASE_TAG"]
    commit = os.environ["SOURCE_COMMIT"]
    build_id = os.environ["EXPECTED_BUILD_ID"]
    package_sha = os.environ["PACKAGE_SHA256"].lower()
    assert re.fullmatch(r"v[0-9][0-9A-Za-z.-]*", tag)
    assert re.fullmatch(r"[0-9a-f]{40}", commit)
    assert re.fullmatch(r"[0-9]{14}", build_id)
    assert re.fullmatch(r"[0-9a-f]{64}", package_sha)
    package = Path("candidate") / f"firefox-reverse-{tag}-windows-x86_64.zip"
    assert sha(package) == package_sha
    report.update(platform="Windows", source_commit=commit, package_sha256=package_sha)
    with temporary_workspace() as work:
        work = Path(work)
        with zipfile.ZipFile(package) as archive:
            for name in archive.namelist():
                target = (work / name).resolve()
                assert target.is_relative_to(work.resolve()), "Unsafe ZIP path"
            assert archive.testzip() is None
            archive.extractall(work)
        root = work / "firefox"
        executable = root / "firefox.exe"
        report["binary_sha256"] = sha(executable)
        ini = configparser.ConfigParser()
        ini.read(root / "application.ini", encoding="utf-8")
        assert ini["App"]["BuildID"] == build_id
        assert ini["App"]["SourceStamp"] == commit
        expected_ledger = subprocess.check_output([
            "git", "show", f"{commit}:additions/browser/components/agent-sidebar/modules/LedgerBackend.sys.mjs"
        ])
        with zipfile.ZipFile(root / "browser/omni.ja") as archive:
            assert archive.read("modules/agentsidebar/LedgerBackend.sys.mjs") == expected_ledger
            assert "右击或下拉显示历史" in archive.read("localization/zh-CN/browser/browserContext.ftl").decode()

        profile = work / "screenshot-profile"
        profile.mkdir()
        screenshot = output / "windows-native.png"
        process = None
        try:
            with (output / "screenshot.log").open("wb") as log:
                process = subprocess.Popen([
                    str(executable), "--headless", "--no-remote", "--no-deelevate", "--wait-for-browser", "--profile", str(profile),
                    "--screenshot", str(screenshot),
                    "data:text/html,%3Cbody%3EFirefox%20Reverse%20native%20validation%3C/body%3E"
                ], stdout=log, stderr=log)
                report["screenshot_exit_code"] = process.wait(timeout=90)
            assert report["screenshot_exit_code"] == 0
            image = screenshot.read_bytes()
            assert image[:8] == b"\x89PNG\r\n\x1a\n"
            width, height = struct.unpack(">II", image[16:24])
            assert width > 0 and height > 0
            report.update(screenshot_sha256=sha(screenshot), screenshot_size=len(image))
        finally:
            stop(process)

        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        profile = work / "ledger-profile"
        profile.mkdir()
        env = dict(os.environ, MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS=json.dumps({"marionette.port": port}))
        process = None
        connection = None
        try:
            with (output / "ledger.log").open("wb") as log:
                process = subprocess.Popen([str(executable), "-headless", "-no-remote", "-no-deelevate", "-wait-for-browser", "-profile", str(profile),
                    "-marionette", "-remote-allow-system-access", "about:blank"], env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 60
                while connection is None:
                    assert process.poll() is None, "Browser exited before Marionette"
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=2)
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.25)
                connection.settimeout(60)
                wire = Wire(connection)
                wire.read()
                wire.command("WebDriver:NewSession", {})
                wire.command("Marionette:SetContext", {"value": "chrome"})
                result = wire.command("WebDriver:ExecuteAsyncScript", {
                    "script": """
                    const done=arguments[arguments.length-1];
                    (async()=>{
                      const {LedgerBackend,ledgerScopeSql}=ChromeUtils.importESModule('resource:///modules/agentsidebar/LedgerBackend.sys.mjs');
                      const ledger=new LedgerBackend();
                      const workspace=PathUtils.join(PathUtils.profileDir,'native-ledger');
                      await IOUtils.makeDirectory(workspace);
                      const ctx={workspaceRoot:workspace};
                      const text="native payload '); DROP TABLE mem;--";
                      await ledger.append({text},ctx);
                      const recall=await ledger.recall({query:'payload'},ctx);
                      if(recall.count!==1 || recall.results[0].text!==text)throw new Error('roundtrip failed');
                      const duplicate=await ledger.append({text},ctx);
                      if(duplicate.dedupedOld!==1)throw new Error('dedup failed');
                      if((await ledger.recall({},{workspaceRoot:workspace+'-other'})).count!==0)throw new Error('scope leak');
                      await ledger._addMany(Array.from({length:125},(_,i)=>({kind:'fact',text:'uniq'+i})),ctx);
                      const db=await ledger._db();
                      const count=(await db.execute('SELECT count(*) AS c FROM mem WHERE workspace=:w AND kind=:k',{w:workspace,k:'fact'}))[0].getResultByName('c');
                      if(count!==120)throw new Error('cap failed');
                      let rejected=false;try{ledgerScopeSql('site OR 1=1');}catch{rejected=true;}
                      if(!rejected)throw new Error('allowlist failed');
                      await db.close();
                      return {passed:true,build:Services.appinfo.appBuildID,version:Services.prefs.getStringPref('extensions.firefox-reverse.version'),checks:['roundtrip','dedup','scope','cap','allowlist']};
                    })().then(done,e=>done({error:String(e)}));
                    """, "args": [], "newSandbox": False, "scriptTimeout": 60000,
                })
                result = result.get("value", result)
                assert result.get("passed") is True, result
                assert result["build"] == build_id and result["version"] == tag[1:]
                report.update(runtime_build_id=result["build"], ledger_passed=True, ledger_checks=result["checks"])
                wire.command("Marionette:Quit", {})
                report["ledger_exit_code"] = process.wait(timeout=30)
                assert report["ledger_exit_code"] == 0
        finally:
            if connection:
                connection.close()
            stop(process)
    report["status"] = "passed"


if __name__ == "__main__":
    output = Path("native-report").resolve()
    output.mkdir(exist_ok=True)
    report = {"status": "failed", "run_id": os.environ.get("GITHUB_RUN_ID")}
    try:
        validate(report, output)
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (output / "WINDOWS-NATIVE-REPORT.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
