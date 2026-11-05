"""Verify sidebar settings using synthetic localhost responses and an owned profile.

--app validates an extracted final package without changing its resources.
--package retains the Windows resource-overlay fixture used during PR review;
that mode is not final-package acceptance.
"""
import argparse
import base64
import configparser
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import zipfile

REPO = Path(__file__).resolve().parents[1]
SIDEBAR = REPO / "additions/browser/components/agent-sidebar"
spec = importlib.util.spec_from_file_location("native", REPO / "scripts/verify-windows-package.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
PROMPT_A = "  NATIVE_POLICY_A\n中文回复，保留 English 技术术语。  "
PROMPT_B = "NATIVE_POLICY_B\nNext user turn only."
UI_PREFIX = "chrome/browser/content/browser/agent-sidebar/"
SOURCE_RESOURCES = {
    "modules/agentsidebar/AgentSession.sys.mjs": "modules/AgentSession.sys.mjs",
    "modules/agentsidebar/ConfigStore.sys.mjs": "modules/ConfigStore.sys.mjs",
    UI_PREFIX + "agent-panel.css": "content/agent-panel.css",
}


def application_paths(app):
    app = app.resolve()
    if app.suffix == ".app" and app.is_dir():
        return app / "Contents/MacOS/firefox", app / "Contents/Resources", app / "Contents/MacOS/XUL"
    executable = app if app.is_file() else app / ("firefox.exe" if os.name == "nt" else "firefox")
    root = executable.parent
    return executable, root, root / ("xul.dll" if executable.suffix == ".exe" else "libxul.so")


def verify_final_resources(app, source_commit, build_id, bundle_sha256):
    assert re.fullmatch(r"[0-9a-f]{40}", source_commit), "Expected full source commit"
    assert re.fullmatch(r"[0-9]{14}", build_id), "Expected BuildID"
    assert re.fullmatch(r"[0-9a-f]{64}", bundle_sha256), "Expected rebuilt sidebar SHA256"
    executable, root, xul = application_paths(app)
    assert executable.is_file() and xul.is_file(), "Incomplete application"
    ini = configparser.ConfigParser(interpolation=None)
    ini.read(root / "application.ini", encoding="utf-8")
    assert ini["App"]["SourceStamp"] == source_commit, "SourceStamp mismatch"
    assert ini["App"]["BuildID"] == build_id, "BuildID mismatch"
    hashes = {}
    with zipfile.ZipFile(root / "browser/omni.ja") as archive:
        for entry, relative in SOURCE_RESOURCES.items():
            expected = subprocess.check_output([
                "git", "show", f"{source_commit}:additions/browser/components/agent-sidebar/{relative}"
            ], cwd=REPO)
            actual = archive.read(entry)
            assert actual == expected, f"Stale packaged resource: {relative}"
            hashes[entry] = hashlib.sha256(actual).hexdigest()
        entry = UI_PREFIX + "agent-sidebar.bundle.js"
        hashes[entry] = hashlib.sha256(archive.read(entry)).hexdigest()
        assert hashes[entry] == bundle_sha256, "Sidebar bundle mismatch"
    return {"resource_sha256": hashes, "xul_sha256": native.sha(xul),
            "source_commit": source_commit, "build_id": build_id}


def wait_for(predicate, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise TimeoutError(label)


class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        users = [str(m.get("content", "")) for m in body["messages"] if m["role"] == "user"]
        task = next((name for user in reversed(users) for name in ("NATIVE_AUTO", "NATIVE_RUNNING", "NATIVE_AFTER", "NATIVE_SWITCH", "NATIVE_HISTORY", "NATIVE_DEFAULT", "NATIVE_RESTART", "NATIVE_FIRST") if name in user), "unknown")
        records = self.server.records
        index = sum(r["task"] == task for r in records)
        records.append({"task": task, "model": body["model"], "system": body["messages"][0]["content"]})
        if task == "NATIVE_RUNNING" and index == 0:
            if not self.server.release.wait(30):
                raise TimeoutError("running-turn test was not released")
        tool = (task in ("NATIVE_RUNNING", "NATIVE_AUTO") and index == 0)
        message = {"role": "assistant", "content": "## 结论\n本地验收已完成。"}
        if tool:
            message = {"role": "assistant", "content": "", "tool_calls": [{"id": "synthetic-call", "type": "function", "function": {"name": "page_info", "arguments": "{}"}}]}
        finish = "tool_calls" if tool else "stop"
        if body.get("stream"):
            data = "data: " + json.dumps({"choices": [{"index": 0, "delta": message, "finish_reason": finish}]}) + "\n\ndata: [DONE]\n\n"
            mime = "text/event-stream"
        else:
            data = json.dumps({"choices": [{"index": 0, "message": message, "finish_reason": finish}]})
            mime = "application/json"
        encoded = data.encode()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class Browser:
    def __init__(self, app, profile, output, run, build_id=None):
        self.log = (output / f"firefox-{run}.log").open("wb")
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        env = {k: v for k, v in os.environ.items() if not k.startswith(("MOZ_FRX_", "FRX_ENV_", "XRE_PROFILE_", "MOZ_DISABLE_CONTENT_SANDBOX"))}
        env["MOZ_MARIONETTE"] = "1"
        env["MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS"] = json.dumps({"marionette.port": port})
        executable, _, _ = application_paths(app)
        flags = ["-no-deelevate", "-wait-for-browser"] if os.name == "nt" else []
        self.process = subprocess.Popen([str(executable), "-headless", "-new-instance", "-no-remote", *flags, "-profile", str(profile), "-purgecaches", "-marionette", "-remote-allow-system-access", "about:blank"], env=env, stdout=self.log, stderr=self.log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.connection = None
        self.wire = None
        try:
            def connect():
                assert self.process.poll() is None, "Firefox exited during startup"
                try:
                    self.connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                    return True
                except OSError:
                    return False
            wait_for(connect, "Marionette startup", 90)
            self.connection.settimeout(40)
            self.wire = native.Wire(self.connection)
            self.wire.read()
            self.wire.command("WebDriver:NewSession", {})
            self.wire.command("Marionette:SetContext", {"value": "chrome"})
            identity = self.execute("await win.SidebarController.show('viewAgentSidebar'); await until(() => doc()?.querySelector('[aria-label=\"设置\"]')); return {build: Services.appinfo.appBuildID, profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path};")
            assert Path(identity["profile"]).samefile(profile), "Unexpected profile; refusing to modify settings"
            if build_id:
                assert identity["build"] == build_id, "Runtime BuildID mismatch"
        except BaseException:
            self.close(force=True)
            raise

    def execute(self, code, args=None):
        helpers = """
        const done=arguments[arguments.length-1];
        const input=arguments[0];
        const win=Services.wm.getMostRecentWindow('navigator:browser');
        const doc=()=>win.document.getElementById('sidebar').contentDocument;
        const sleep=ms=>new Promise(r=>win.setTimeout(r,ms));
        const until=async f=>{for(let i=0;i<200;i++){if(f())return;await sleep(50);}throw Error('DOM timeout');};
        const store=ChromeUtils.importESModule('resource:///modules/agentsidebar/ConfigStore.sys.mjs').configStore;
        const session=ChromeUtils.importESModule('resource:///modules/agentsidebar/AgentSession.sys.mjs').agentSession;
        const conversations=ChromeUtils.importESModule('resource:///modules/agentsidebar/ConversationStore.sys.mjs').conversationStore;
        const setValue=(el,value)=>{
          const w=el.ownerDocument.defaultView;
          const proto=el.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:el.tagName==='SELECT'?w.HTMLSelectElement.prototype:w.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
          el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));
        };
        const settings=async()=>{if(!doc().querySelector('.settings-pane'))doc().querySelector('[aria-label="设置"]').click();await until(()=>doc().querySelector('.settings-pane textarea'));};
        const closeSettings=async()=>{doc().querySelector('.settings-pane__bar button')?.click();await until(()=>!doc().querySelector('.settings-pane'));};
        """
        result = self.wire.command("WebDriver:ExecuteAsyncScript", {"script": helpers + "(async()=>{" + code + "})().then(done,e=>done({testError:String(e),stack:e.stack}));", "args": [args], "scriptTimeout": 30000, "newSandbox": False})
        result = result.get("value", result)
        assert not isinstance(result, dict) or "testError" not in result, result
        return result

    def save(self, value):
        return self.execute("await settings(); setValue(doc().querySelector('.settings-pane textarea'), input); await sleep(100); doc().querySelector('.settings-pane__actions button').click(); await until(()=>doc().querySelector('.settings-pane__saved')); if(store.getGlobalSystemPrompt()!==input)throw Error('UI save did not reach prefs'); await closeSettings(); await settings(); return doc().querySelector('.settings-pane textarea').value;", value)

    def send(self, task):
        self.execute("await closeSettings(); setValue(doc().querySelector('.agent-panel__input textarea'),input); await sleep(100); const send=doc().querySelector('.agent-panel__input button'); if(send.disabled)throw Error('Send disabled');send.click();return true;", task)

    def settled(self):
        return self.execute("return session.listRunning().length===0 && !doc().querySelector('.agent-panel__stop') && !doc().querySelector('.agent-panel__error');")

    def close(self, force=False):
        try:
            if self.wire and not force:
                # Match verify-windows-package.py: close the test-opened ledger
                # connection before shutdown, rather than hiding a quit timeout.
                self.execute("const ledger=ChromeUtils.importESModule('resource:///modules/agentsidebar/Backends.sys.mjs').getBackends().ledger;if(ledger._conn)await ledger._conn.close();return true;")
                self.wire.command("Marionette:Quit", {"flags": ["eForceQuit"]})
                code = self.process.wait(timeout=20)
                assert code == 0, f"Firefox exit={code}"
                return code
        finally:
            if self.connection:
                self.connection.close()
            if os.name == "nt":
                native.stop(self.process)
            elif self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=15)
            self.log.close()


def prepare(package, root):
    with zipfile.ZipFile(package) as archive:
        for entry in archive.namelist():
            assert (root / entry).resolve().is_relative_to(root.resolve()), "Unsafe package entry"
        archive.extractall(root)
    app = root / "firefox"
    resources = {
        "modules/agentsidebar/AgentSession.sys.mjs": SIDEBAR / "modules/AgentSession.sys.mjs",
        # AgentSession imports createRunState from AgentLoop: overlay the pair, or an older package fails to link.
        "modules/agentsidebar/AgentLoop.sys.mjs": SIDEBAR / "modules/AgentLoop.sys.mjs",
        "modules/agentsidebar/ConfigStore.sys.mjs": SIDEBAR / "modules/ConfigStore.sys.mjs",
        "chrome/browser/content/browser/agent-sidebar/agent-sidebar.bundle.js": SIDEBAR / "content/agent-sidebar.bundle.js",
        "chrome/browser/content/browser/agent-sidebar/agent-panel.css": SIDEBAR / "content/agent-panel.css",
    }
    omni = app / "browser/omni.ja"
    candidate = omni.with_suffix(".candidate")
    with zipfile.ZipFile(omni) as original, zipfile.ZipFile(candidate, "w") as patched:
        for info in original.infolist():
            patched.writestr(info, resources[info.filename].read_bytes() if info.filename in resources else original.read(info.filename))
    with zipfile.ZipFile(candidate) as check:
        assert check.testzip() is None
    candidate.replace(omni)
    return app, {name: native.sha(path) for name, path in resources.items()}


def verify(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "failed", "platform": platform.system(), "architecture": platform.machine(),
              "mode": "final-package" if args.app else "resource-overlay", "checks": [], "browser_exit_codes": []}
    if args.package:
        assert os.name == "nt", "The legacy overlay fixture requires Windows"
        report["package_sha256"] = native.sha(args.package)
        assert report["package_sha256"] == args.package_sha256.lower(), "Package SHA256 mismatch"
    root = Path(tempfile.mkdtemp(prefix="frx-global-prompt-"))
    browser = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    server.records = []
    server.release = threading.Event()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        if args.app:
            app = args.app.resolve()
            report.update(verify_final_resources(app, args.source_commit, args.build_id, args.bundle_sha256))
        else:
            app, resources = prepare(args.package, root)
            report.update(resource_sha256=resources, xul_sha256=native.sha(app / "xul.dll"))
        profile = root / "profile"
        profile.mkdir()
        (profile / "user.js").write_text('\n'.join([
            'user_pref("browser.aboutwelcome.enabled",false);',
            'user_pref("browser.shell.checkDefaultBrowser",false);',
            'user_pref("browser.startup.homepage_override.mstone","ignore");',
            'user_pref("browser.newtabpage.enabled",false);',
            'user_pref("datareporting.policy.dataSubmissionEnabled",false);',
            'user_pref("toolkit.telemetry.enabled",false);',
            'user_pref("app.update.auto",false);',
        ]), encoding="utf-8")
        browser = Browser(app, profile, output, 1, args.build_id)
        report.update(browser.execute("return {build:Services.appinfo.appBuildID,version:Services.appinfo.version,release:Services.prefs.getStringPref('extensions.firefox-reverse.version')};"))
        ids = browser.execute("store.setContextStrategy('legacy');store.setPromptCacheMode('off');return ['model-a','model-b'].map(model=>store.createModelProfile({name:model,provider:'custom',model,baseUrl:input,protocol:'openai',apiKey:'synthetic-test'}).id);", f"http://127.0.0.1:{server.server_address[1]}")
        assert browser.save(PROMPT_A) == PROMPT_A
        report["checks"].append("sidebar UI save and reopen preserves multiline text")
        try:
            browser.execute("doc().querySelector('.settings-pane textarea').scrollIntoView({block:'center'});await sleep(100);return true;")
            image = browser.wire.command("WebDriver:TakeScreenshot", {})
            (output / "settings.png").write_bytes(base64.b64decode(image.get("value", image)))
        except Exception as error:
            report["screenshot_error"] = type(error).__name__

        def inspect(task, expected, model=None, count=None):
            records = [r for r in server.records if r["task"] == task]
            assert records and (count is None or len(records) == count), (task, len(records))
            for record in records:
                text = record["system"]
                if expected:
                    assert text.endswith("\n\n" + expected.strip()), task
                    assert text.count(expected.strip()) == 1, "Duplicate prompt"
                else:
                    assert "NATIVE_POLICY_" not in text, "Clear did not restore default"
                if model:
                    assert record["model"] == model
            return records

        browser.send("NATIVE_FIRST")
        wait_for(lambda: len(server.records) > 0 and browser.settled(), "First sidebar turn")
        first_system = inspect("NATIVE_FIRST", PROMPT_A, "model-b", 1)[0]["system"]
        report["checks"].append("sidebar send appends custom policy once after built-in system")
        report["browser_exit_codes"].append(browser.close())
        browser = Browser(app, profile, output, 2, args.build_id)
        value = browser.execute("await settings();return doc().querySelector('.settings-pane textarea').value;")
        assert value == PROMPT_A
        browser.send("NATIVE_RESTART")
        wait_for(lambda: any(r["task"] == "NATIVE_RESTART" for r in server.records) and browser.settled(), "Restart turn")
        inspect("NATIVE_RESTART", PROMPT_A, "model-b", 1)
        report["checks"].append("full browser restart persists UI value and request policy")

        browser.execute("await settings();setValue(doc().querySelector('.settings-pane__profilebar select'),input);await sleep(100);return store.getActiveModelProfileId();", ids[0])
        value = browser.execute("return doc().querySelector('.settings-pane textarea').value;")
        assert value == PROMPT_A
        browser.execute("await closeSettings();doc().querySelector('[aria-label=\"新对话\"]').click();await sleep(100);return true;")
        browser.send("NATIVE_SWITCH")
        wait_for(lambda: any(r["task"] == "NATIVE_SWITCH" for r in server.records) and browser.settled(), "Switched model/session turn")
        switched_system = inspect("NATIVE_SWITCH", PROMPT_A, "model-a", 1)[0]["system"]
        report["checks"].append("UI model selection and new conversation retain profile-wide policy")

        browser.execute("doc().querySelector('[aria-label=\"历史对话\"]').click();await until(()=>doc().querySelectorAll('.agent-history__item').length>=2);const item=Array.from(doc().querySelectorAll('.agent-history__item')).find(el=>el.querySelector('.agent-history__item-title').textContent.includes('NATIVE_FIRST'));if(!item)throw Error('Original conversation missing');item.click();await until(()=>!doc().querySelector('.agent-history'));return true;")
        browser.send("NATIVE_HISTORY")
        wait_for(lambda: any(r["task"] == "NATIVE_HISTORY" for r in server.records) and browser.settled(), "Reopened conversation turn")
        inspect("NATIVE_HISTORY", PROMPT_A, "model-a", 1)
        report["checks"].append("reopening existing conversation through history keeps current shared policy")

        browser.send("NATIVE_RUNNING")
        wait_for(lambda: any(r["task"] == "NATIVE_RUNNING" for r in server.records), "Held request")
        assert not browser.settled()
        assert browser.save(PROMPT_B) == PROMPT_B
        server.release.set()
        browser.execute("await closeSettings();return true;")
        wait_for(browser.settled, "Running turn finished")
        inspect("NATIVE_RUNNING", PROMPT_A, "model-a", 2)
        browser.send("NATIVE_AFTER")
        wait_for(lambda: any(r["task"] == "NATIVE_AFTER" for r in server.records) and browser.settled(), "Next user turn")
        inspect("NATIVE_AFTER", PROMPT_B, "model-a", 1)
        report["checks"].append("editing settings during real in-flight request leaves all current-round requests unchanged; next user turn uses new policy")

        auto = browser.execute("const t=await conversations.createThread('Synthetic auto-restart');await session.run(t.id,{systemPrompt:'NATIVE_BUILTIN',convo:[{role:'user',content:'NATIVE_AUTO'}],maxRounds:1,maxPerTool:2,win});const s=session.getState(t.id);return {checkpointSeq:s.checkpointSeq,error:s.error};")
        assert auto["checkpointSeq"] == 1 and not auto["error"], auto
        records = inspect("NATIVE_AUTO", PROMPT_B, "model-a", 3)
        assert len({r["system"] for r in records}) == 1
        report["checks"].append("real AgentLoop hits maxRounds and auto-restarts with identical system, no duplicate append")

        assert browser.save("") == ""
        browser.send("NATIVE_DEFAULT")
        wait_for(lambda: any(r["task"] == "NATIVE_DEFAULT" for r in server.records) and browser.settled(), "Default turn")
        default = inspect("NATIVE_DEFAULT", "", "model-a", 1)[0]["system"]
        assert first_system == default + "\n\n" + PROMPT_A.strip()
        assert switched_system == first_system
        report["checks"].append("clearing in UI restores byte-identical built-in prompt")
        report["browser_exit_codes"].append(browser.close())
        browser = None
        if args.app:
            after = verify_final_resources(app, args.source_commit, args.build_id, args.bundle_sha256)
            assert after["resource_sha256"] == report["resource_sha256"], "Package resources changed during verification"
            assert after["xul_sha256"] == report["xul_sha256"], "XUL changed during verification"
            report["package_unchanged"] = True
        report["status"] = "passed"
        report["limitations"] = ["Synthetic localhost model responses, not paid provider acceptance.",
                                 "The test closes its ledger connection before normal browser shutdown."]
        report["requests"] = [{"task": r["task"], "model": r["model"], "system_sha256": hashlib.sha256(r["system"].encode()).hexdigest(), "custom_policy_count": r["system"].count("NATIVE_POLICY_")} for r in server.records]
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    except Exception as error:
        report["error"] = str(error).replace(str(root), "<isolated-test-root>")
        raise
    finally:
        server.release.set()
        if browser:
            browser.close(force=True)
        server.shutdown()
        # Browser logs are diagnostic data and may mention the isolated temp path.
        for path in output.glob("firefox-*.log"):
            text = path.read_text(encoding="utf-8", errors="replace").replace(str(root), "<isolated-test-root>")
            path.write_text(text, encoding="utf-8")
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        for attempt in range(20):
            try:
                shutil.rmtree(root)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--package", type=Path, help="Windows ZIP resource-overlay fixture (not release acceptance)")
    target.add_argument("--app", type=Path, help="Unmodified extracted application directory or executable")
    parser.add_argument("--package-sha256")
    parser.add_argument("--source-commit")
    parser.add_argument("--build-id")
    parser.add_argument("--bundle-sha256")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    required = ("source_commit", "build_id", "bundle_sha256") if args.app else ("package_sha256",)
    for name in required:
        if not getattr(args, name):
            parser.error("--" + name.replace("_", "-") + " is required for this mode")
    verify(args)
