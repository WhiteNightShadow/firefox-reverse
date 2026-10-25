#!/usr/bin/env node
// Environment lifecycle cases that only a real browser shows, run against an unmodified final package:
//   quit-channel  close while an external WebDriver session holds the environment's Marionette; the
//                 browser must exit through the quit channel and keep the cookie and localStorage.
//   identity      a backend instance that did not launch the process (host restart, other window)
//                 must recognise the environment by its command line, and must neither trust nor
//                 signal a recorded pid that now belongs to another program.
//   restart       after the environment exits behind the backend's back, a fresh backend reports it
//                 stopped and can open it again.
// Every profile, environment and data directory belongs to this run and is removed afterwards.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SCENARIOS = ["quit-channel", "identity", "restart"];
const options = process.argv.slice(2);
const option = key => (options.includes(key) ? options[options.indexOf(key) + 1] : undefined);
assert(option("--firefox") && option("--mcp-root"), "usage: verify-environment-lifecycle.mjs --firefox <app|binary> --mcp-root <frx-director-mcp> [--xul-sha256 <sha256>] [--scenarios quit-channel,identity,restart] [--output <report.json>]");
const scenarios = (option("--scenarios") || SCENARIOS.join(",")).split(",").filter(Boolean);
for (const name of scenarios) assert(SCENARIOS.includes(name), `unknown scenario: ${name}`);
const app = path.resolve(option("--firefox"));
const executable = app.endsWith(".app") ? path.join(app, "Contents/MacOS/firefox") : app;
const xul = path.join(path.dirname(executable), process.platform === "darwin" ? "XUL" : process.platform === "win32" ? "xul.dll" : "libxul.so");
const xulSHA256 = createHash("sha256").update(await fs.readFile(xul)).digest("hex");
if (option("--xul-sha256")) assert.equal(xulSHA256, option("--xul-sha256"), "XUL differs from the verified package");
const { MarionetteWire } = await import(pathToFileURL(path.resolve(option("--mcp-root"), "dist/bridge/marionetteWire.js")));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs) => {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
  }
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frx-env-lifecycle-"));
const root = path.join(directory, "environments");
const profile = path.join(directory, "controller");
const dataDirs = { HOME: path.join(directory, "home"), MOZ_APP_DATA: path.join(directory, "support"), MOZ_LOCAL_APP_DATA: path.join(directory, "cache") };
for (const dir of [root, profile, ...Object.values(dataDirs)]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(profile, "user.js"), ['user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("browser.startup.homepage_override.mstone", "ignore");', ""].join("\n"));
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>FRX lifecycle</title><p>lifecycle</p>");
});
await listen(server);
const pageURL = `http://127.0.0.1:${server.address().port}/`;
const portServer = net.createServer();
await listen(portServer);
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));

// Environment browsers inherit this environment, so they stay headless and inside the run directory.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(MOZ_|XRE_|FRX_)/.test(key)) delete env[key];
Object.assign(env, dataDirs, { MOZ_HEADLESS: "1", MOZ_MARIONETTE: "1", MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS: JSON.stringify({ "marionette.port": port }) });
const proc = spawn(executable, ["-new-instance", "-no-remote", "-profile", profile, "-marionette", "-remote-allow-system-access", ...(process.platform === "win32" ? ["-no-deelevate", "-wait-for-browser"] : []), "about:blank"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let launchError;
proc.on("error", error => { launchError = error; });
proc.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
proc.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });

// The wire's timeout is also its idle timeout, and an open() may wait for Marionette for 90 seconds.
const connect = async (targetPort, timeoutMs, launched = null) => {
  for (const deadline = Date.now() + timeoutMs; ;) {
    if (launched && (launchError || launched.exitCode !== null)) throw new Error(`launch failed: ${launchError || output}`);
    const wire = new MarionetteWire();
    try {
      await wire.connect("127.0.0.1", targetPort, 300000);
      return wire;
    } catch (error) {
      await wire.close();
      if (Date.now() > deadline) throw error;
      await delay(300);
    }
  }
};

let controller;
const pids = new Set();
const report = { platform: `${process.platform}-${process.arch}`, xulSHA256, scenarios: {} };
try {
  controller = await connect(port, 90000, proc);
  // Backends by name: "launcher" starts the environments; "observer" and "restarted" never launched
  // anything, so like a host browser after a restart they only have the records on disk.
  const call = async (body, args = []) => {
    const value = await controller.executeAsync(`const done = arguments[arguments.length - 1];
      const args = Array.from(arguments).slice(0, -1);
      const { EnvironmentBackend } = ChromeUtils.importESModule("resource:///modules/agentsidebar/EnvironmentBackend.sys.mjs");
      const backends = (window.__frxLifecycle ||= {});
      const backend = name => (backends[name] ||= new EnvironmentBackend({ root: ${JSON.stringify(root)} }));
      (async () => { ${body} })().then(done, error => done({ lifecycleError: String(error), stack: error?.stack || "" }));`, args, 240000);
    if (value?.lifecycleError) throw new Error(`${value.lifecycleError}\n${value.stack}`);
    return value;
  };
  const create = name => call(`return (await backend("launcher").create({ name: args[0] })).environment.id;`, [name]);
  const open = async (backend, id) => {
    const opened = await call(`const o = await backend(args[0]).open({ id: args[1], url: "about:blank" }); const r = o.environment?.runtime || {};
      return { launched: !!o.launched, alreadyRunning: !!o.alreadyRunning, controlDir: o.environment?.controlDir, status: r.status, pid: r.pid, marionettePort: r.marionettePort, marionetteReady: !!r.marionetteReady };`, [backend, id]);
    if (opened.pid) pids.add(opened.pid);
    return opened;
  };
  const close = (backend, id) => call(`const c = await backend(args[0]).close({ id: args[1] }); const r = c.environment?.runtime || {};
    return { ok: !!c.ok, error: c.error || null, status: r.status, stopReason: r.stopReason || null, closedBy: r.closedBy || null };`, [backend, id]);
  const status = (backend, id) => call(`return (await backend(args[0]).status({ id: args[1] })).environment.runtime.status;`, [backend, id]);
  const pidState = (backend, id) => call(`const b = backend(args[0]); const env = await b._store.loadEnv(args[1]); return b._processes.pidState(env.runtime.pid, env.id, env, { strict: true });`, [backend, id]);
  const channelReady = opened => waitFor(() => existsSync(path.join(opened.controlDir, "quit-channel.json")), 15000);
  // The environment polls for the request every 500 ms; the backend withdraws an untaken one after 3 s.
  const watchRequest = controlDir => {
    const file = path.join(controlDir, "quit-request.json");
    let appeared = null;
    let gone = null;
    const timer = setInterval(() => {
      const exists = existsSync(file);
      if (exists && appeared === null) appeared = Date.now();
      else if (!exists && appeared !== null && gone === null) gone = Date.now();
    }, 20);
    return () => {
      clearInterval(timer);
      return appeared === null || gone === null ? null : gone - appeared;
    };
  };
  const remove = id => call(`const b = backend("launcher"); try { if ((await b.status({ id: args[0] })).environment.runtime.status !== "stopped") await b.close({ id: args[0] }); } catch {}
    return (await b.delete({ id: args[0], confirm: true })).ok;`, [id]).catch(() => false);
  const page = async (wire, script) => {
    await wire.command("Marionette:SetContext", { value: "content" });
    await wire.command("WebDriver:Navigate", { url: pageURL });
    return (await wire.command("WebDriver:ExecuteScript", { args: [], script })).value;
  };
  report.buildID = await call(`return Services.appinfo.appBuildID;`);

  const run = {
    async "quit-channel"(check) {
      const id = await create("Lifecycle quit channel");
      const wires = [];
      const closeThroughChannel = async (opened, label) => {
        const stopWatching = watchRequest(opened.controlDir);
        const started = Date.now();
        const closed = await close("launcher", id);
        const ms = Date.now() - started;
        const requestGoneMs = stopWatching();
        check(`${label}: close succeeds`, closed.ok, closed);
        // If the close fell back to a signal, the request file tells why: taken quickly means the browser
        // stalled on its way out (known when Mozilla services are unreachable); withdrawn after 3 s means
        // the environment never answered.
        const why = requestGoneMs === null ? "request not observed" : requestGoneMs < 2500 ? "request taken, but the browser did not exit within the 15 s close wait (known when Mozilla services are unreachable)" : "request not taken; the backend withdrew it";
        check(`${label}: close goes through the quit channel`, closed.closedBy === "quit-channel", { ...closed, ms, requestGoneMs, why });
        check(`${label}: environment process exits`, await waitFor(() => !alive(opened.pid), 5000));
        return ms;
      };
      try {
        const opened = await open("launcher", id);
        check("environment opens", opened.launched && opened.status === "running" && opened.marionetteReady, opened);
        check("quit channel becomes ready", await channelReady(opened));
        // An external client (MCP, Selenium) holds the environment's Marionette session.
        const external = await connect(opened.marionettePort, 30000);
        wires.push(external);
        const written = await page(external, `document.cookie = "frx_lifecycle=kept; max-age=86400; path=/"; localStorage.setItem("frx_lifecycle", "kept-${Date.now()}"); return localStorage.getItem("frx_lifecycle");`);
        await delay(1000);
        const closeMs = await closeThroughChannel(opened, "with an external session holding Marionette");
        check("external session is dropped", await waitFor(() => !external.isConnected(), 5000));
        const reopened = await open("launcher", id);
        check("environment reopens", reopened.launched && reopened.status === "running", reopened);
        const reader = await connect(reopened.marionettePort, 30000);
        wires.push(reader);
        const [cookie, stored] = await page(reader, 'return [document.cookie, localStorage.getItem("frx_lifecycle")];');
        check("cookie written before the close is kept", String(cookie).includes("frx_lifecycle=kept"), cookie);
        check("localStorage written before the close is kept", stored === written, { stored, written });
        await reader.command("WebDriver:DeleteSession", {}).catch(() => {});
        await reader.close();
        const closeWithoutExternalMs = await closeThroughChannel(reopened, "without an external session");
        return { closeMs, closeWithoutExternalMs };
      } finally {
        for (const wire of wires) await wire.close();
        await remove(id);
      }
    },

    async identity(check) {
      const id = await create("Lifecycle identity");
      const decoy = await create("Lifecycle identity decoy");
      try {
        const opened = await open("launcher", id);
        check("environment opens", opened.launched && opened.status === "running", opened);
        await channelReady(opened);
        check("a backend that did not launch it sees the environment running", (await status("observer", id)) === "running");
        const state = await pidState("observer", id);
        check("strict identity check recognises the environment process", state === "alive", state);
        const closed = await close("observer", id);
        check("that backend closes the environment", closed.ok, closed);
        check("environment process exits", await waitFor(() => !alive(opened.pid), 5000));
        const decoys = {};
        for (const [label, pid] of [["controller browser", await call(`return Services.appinfo.processID;`)], ["verifier", process.pid]]) {
          // The record now points at a live process of another program. For the controller it is the
          // same Firefox binary, so only the command line can tell the two apart.
          await call(`const b = backend("launcher"); const env = await b._store.loadEnv(args[0]); env.runtime = { ...(env.runtime || {}), status: "running", pid: args[1], firefoxBin: args[2] }; await b._store.saveRuntime(env); return true;`, [decoy, pid, executable]);
          const decoyState = await pidState("observer", decoy);
          check(`${label} pid is not taken for the environment`, decoyState === "dead", decoyState);
          const result = await close("observer", decoy);
          await delay(1500);
          check(`closing the stale record leaves the ${label} running`, result.ok && result.status === "stopped" && alive(pid), result);
          decoys[label] = { state: decoyState, closedBy: result.closedBy };
        }
        return { decoys };
      } finally {
        await remove(id);
        await remove(decoy);
      }
    },

    async restart(check) {
      const id = await create("Lifecycle restart");
      try {
        const opened = await open("launcher", id);
        check("environment opens", opened.launched && opened.status === "running", opened);
        await channelReady(opened);
        // The environment window is closed behind the backend's back.
        process.kill(opened.pid);
        check("environment process exits", await waitFor(() => !alive(opened.pid), 10000));
        check("after a host restart the environment shows as stopped", (await status("restarted", id)) === "stopped");
        const reopened = await open("restarted", id);
        check("the environment opens again", reopened.launched && !reopened.alreadyRunning && reopened.status === "running", reopened);
        const closed = await close("restarted", id);
        check("the reopened environment closes", closed.ok, closed);
        check("reopened process exits", await waitFor(() => !alive(reopened.pid), 5000));
        return {};
      } finally {
        await remove(id);
      }
    },
  };

  for (const name of scenarios) {
    const checks = [];
    const check = (label, value, detail) => {
      if (!value) throw new Error(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
      checks.push(label);
    };
    const started = Date.now();
    try {
      report.scenarios[name] = { status: "passed", checks, ...(await run[name](check)), ms: Date.now() - started };
    } catch (error) {
      report.scenarios[name] = { status: "failed", checks, error: error.message, ms: Date.now() - started };
    }
  }
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (controller) {
    await controller.execute("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);").catch(() => {});
    await controller.close();
  }
  for (let i = 0; i < 50 && proc.exitCode === null && proc.signalCode === null; i++) await delay(100);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

const failed = Object.entries(report.scenarios).filter(([, result]) => result.status !== "passed").map(([name]) => name);
report.status = failed.length ? "failed" : "passed";
report.limitations = ["Local synthetic page only", "A host restart is simulated with a backend instance that never launched the environment"];
if (option("--output")) await fs.writeFile(option("--output"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exit(1);
