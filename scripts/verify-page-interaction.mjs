#!/usr/bin/env node
// Synthetic fixtures only. Every browser process/profile is owned by this run.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const options = process.argv.slice(2);
const option = key => options[options.indexOf(key) + 1];
assert(options.includes("--firefox") && options.includes("--mcp-root") && options.includes("--xul-sha256"));
const app = path.resolve(option("--firefox"));
const executable = app.endsWith(".app") ? path.join(app, "Contents/MacOS/firefox") : app;
const xul = path.join(path.dirname(executable), process.platform === "darwin" ? "XUL" : process.platform === "win32" ? "xul.dll" : "libxul.so");
const hash = createHash("sha256").update(await fs.readFile(xul)).digest("hex");
assert.equal(hash, option("--xul-sha256"));
const { MarionetteWire } = await import(pathToFileURL(path.resolve(option("--mcp-root"), "dist/bridge/marionetteWire.js")));
const { JS_TOOLS, JS_CALLTOOL } = await import(pathToFileURL(path.resolve(option("--mcp-root"), "dist/bridge/chromeScripts.js")));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frx-page-test-"));
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const portServer = net.createServer();
await listen(portServer);
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
// /replay/* answers gzip-compressed text that changes with `live`, so replay must serve the recording (decoded)
// instead of the network, and the hit counter shows whether the server was asked at all.
const replayServer = { live: "live-1", hits: 0 };
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/replay/")) {
    replayServer.hits++;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end(gzipSync(`${replayServer.live} ${request.url} 签名`));
    return;
  }
  // /determinism records the first random values before any other script runs, in the page and in a same-origin frame.
  if (request.url.startsWith("/determinism")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>FRX Determinism</title><script>
      window.__determinism={random:[Math.random(),Math.random(),Math.random()],bytes:Array.from(crypto.getRandomValues(new Uint8Array(12))),uuid:crypto.randomUUID()};
      window.__burn=n=>{let s=0;for(let i=0;i<n;i++)s+=Math.random();return s;};
    </script>${request.url === "/determinism" ? '<iframe src="/determinism-frame"></iframe>' : ""}`);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cross = origin.replace("127.0.0.1", "localhost");
  const fixture = `<style>button,input{margin:8px;padding:12px}iframe{width:600px;height:250px}body{margin:0}#cover{position:relative;display:inline-block}#overlay{position:absolute;inset:0;background:rgba(0,0,0,.1)}</style>
    <script>window.__frxEvents=[];for(const type of ["mousemove","pointerdown","mousedown","pointerup","mouseup","click","keydown","keypress","beforeinput","input","keyup","compositionstart","compositionend","submit"])document.addEventListener(type,event=>__frxEvents.push([type,event.isTrusted,event.target.id||event.target.localName,event.key||event.inputType||""]),true);</script>
    <button id="go" onclick="this.dataset.clicked='yes';this.dataset.trusted=String(event.isTrusted)" aria-label="Continue">Go</button>
    <form id="form" onsubmit="event.preventDefault();this.dataset.submitted=String(event.isTrusted)"><label for="account">Account</label><input id="account" onkeyup="this.dataset.enter=String(event.key==='Enter' && event.keyCode===13 && event.which===13)"><button id="send">Send</button></form><input type="password" aria-label="Secret" value="never-in-snapshot">
    <button>Duplicate</button><button>Duplicate</button><button hidden>Hidden</button>
    <span id="cover"><button id="covered" onclick="this.dataset.clicked='yes'">Covered</button><span id="overlay"></span></span>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow</button>';</script>`;
  response.end(`<!doctype html><title>FRX Page Fixture</title>${fixture}${request.url === "/" ? `<iframe src="${cross}/child"></iframe>` : request.url === "/child" ? `<iframe src="${origin}/nested"></iframe>` : ""}`);
});
await listen(server);
await fs.writeFile(path.join(directory, "user.js"), 'user_pref("browser.shell.checkDefaultBrowser",false);\nuser_pref("browser.startup.homepage","about:blank");\nuser_pref("browser.aboutwelcome.enabled",false);\n');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(MOZ_FRX_|FRX_ENV_|XRE_PROFILE_|MOZ_DISABLE_CONTENT_SANDBOX)/.test(key)) delete env[key];
Object.assign(env, { MOZ_MARIONETTE: "1", MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS: JSON.stringify({ "marionette.port": port }) });
const proc = spawn(executable, ["-new-instance", "-no-remote", "-profile", directory, "-marionette", "-remote-allow-system-access", ...(process.platform === "win32" ? ["-no-deelevate", "-wait-for-browser"] : []), "about:blank"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let launchError;
proc.on("error", error => { launchError = error; });
proc.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
proc.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
let wire;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const check = (label, value) => { assert(value, label); checks.push(label); };
try {
  const deadline = Date.now() + 90000;
  while (true) {
    if (launchError || proc.exitCode !== null) throw new Error(`launch failed: ${launchError || output}`);
    wire = new MarionetteWire();
    try { await wire.connect("127.0.0.1", port, 10000); break; }
    catch (error) { await wire.close(); if (Date.now() > deadline) throw error; await delay(300); }
  }
  const identity = await wire.execute('return {profile:Services.dirsvc.get("ProfD",Ci.nsIFile).path,buildID:Services.appinfo.appBuildID};');
  check("owned profile", await fs.realpath(identity.profile) === await fs.realpath(directory));
  await wire.command("Marionette:SetContext", { value: "content" });
  await wire.command("WebDriver:Navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await wire.command("Marionette:SetContext", { value: "chrome" });
  await wire.execute('const win=Services.wm.getMostRecentWindow("navigator:browser");win.__frxPageTest=new (ChromeUtils.importESModule("resource:///modules/agentsidebar/PageBackend.sys.mjs").PageBackend)();');
  const call = (method, args = {}) => wire.executeAsync(`const done=arguments[arguments.length-1];const win=Services.wm.getMostRecentWindow("navigator:browser");Promise.resolve().then(()=>win.__frxPageTest[${JSON.stringify(method)}](${JSON.stringify(args)},{win})).then(done,error=>done({ok:false,error:String(error)}));`);
  let snapshot;
  for (let i = 0; i < 60; i++) { snapshot = await call("snapshot", { frameId: "all" }); if (snapshot.frames?.length === 3 && !snapshot.partial) break; await delay(200); }
  assert(snapshot.frames?.length === 3 && !snapshot.partial, `three nested frames: ${JSON.stringify(snapshot)}`);
  checks.push("three nested frames");
  check("password redaction", !JSON.stringify(snapshot).includes("never-in-snapshot"));
  check("open shadow roots", snapshot.elements.filter(e => e.name === "Shadow").length === 3);
  const frame = snapshot.frames[2].frameId;
  const found = await call("find", { frameId: frame, role: "button", name: "Continue" });
  check("semantic nested lookup", found.count === 1);
  check("nested reference click", (await call("click", { ref: found.elements[0].ref })).ok);
  check("ambiguous target rejected", /ambiguous_target/.test((await call("click", { frameId: frame, name: "Duplicate" })).error));
  const nestedTyped = await call("type", { frameId: frame, label: "Account", text: "filled-value", submit: true });
  assert(nestedTyped.ok, `semantic type treats text as value: ${JSON.stringify(nestedTyped)}`);
  checks.push("semantic type treats text as value");
  await call("scroll", { ref: found.elements[0].ref });
  const childRect = (await call("find", { frameId: frame, role: "button", name: "Continue" })).elements[0].rect;
  check("nested frame coordinate click", (await call("click", { frameId: frame, x: childRect.x + 5, y: childRect.y + 5 })).ok);
  await wire.command("Marionette:SetContext", { value: "content" });
  await wire.command("WebDriver:SwitchToFrame", { id: 0 });
  await wire.command("WebDriver:SwitchToFrame", { id: 0 });
  check("nested click changes DOM", await wire.execute("return document.querySelector('#go').dataset.clicked === 'yes';"));
  check("nested coordinates target correct frame", await wire.execute("return document.querySelector('#go').dataset.trusted === 'true';"));
  check("nested input changes DOM", await wire.execute("return document.querySelector('#account').value === 'filled-value';"));
  check("nested input preserves legacy Enter fields", await wire.execute("return document.querySelector('#account').dataset.enter === 'true';"));
  await wire.command("WebDriver:SwitchToFrame", { id: null });
  await wire.command("Marionette:SetContext", { value: "chrome" });
  const topButton = (await call("find", { role: "button", name: "Continue" })).elements[0];
  const coordinates = await call("click", { x: topButton.rect.x + 5, y: topButton.rect.y + 5 });
  assert(coordinates.ok, `coordinate click: ${JSON.stringify(coordinates)}; target=${JSON.stringify(topButton)}`);
  checks.push("coordinate click");
  check("coordinate click dispatched trusted event", (await call("eval", { expression: "document.querySelector('#go').dataset.trusted" })).value === "true");
  // Native input: trusted, complete sequences and browser default actions, for the old selector/text calls too.
  const events = async () => JSON.parse((await call("eval", { expression: "JSON.stringify(window.__frxEvents.splice(0))" })).value);
  const inOrder = (log, wanted) => wanted.map(type => log.findIndex(entry => entry[0] === type)).every((index, position, found) => index >= 0 && (position === 0 || index > found[position - 1]));
  await events();
  check("legacy selector click", (await call("click", { selector: "#go" })).ok);
  const clickLog = await events();
  check("click travels with trusted mouse moves", clickLog.filter(entry => entry[0] === "mousemove" && entry[1]).length >= 2);
  const pressed = clickLog.filter(entry => ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].includes(entry[0]));
  check("click is a trusted down/up/click sequence on the target", pressed.length === 5 && pressed.every(entry => entry[1] && entry[2] === "go") && inOrder(pressed, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]));
  const typed = await call("type", { selector: "#account", text: "Ab中", submit: true });
  check("typing reports the final value", typed.ok && typed.valueMatches === true && typed.submitted === true);
  const typeLog = await events();
  const keydowns = typeLog.filter(entry => entry[0] === "keydown").map(entry => entry[3]);
  check("typing presses each ASCII key with Shift for capitals", ["Shift", "A", "b", "Enter"].every(key => keydowns.includes(key)) && keydowns.indexOf("Shift") < keydowns.indexOf("A"));
  check("typing sends trusted keypress, beforeinput and input", ["keypress", "beforeinput", "input", "keyup"].every(type => typeLog.some(entry => entry[0] === type && entry[1])));
  check("non-ASCII text arrives through a composition", ["compositionstart", "compositionend"].every(type => typeLog.some(entry => entry[0] === type && entry[1])));
  check("typed value", (await call("eval", { expression: "document.querySelector('#account').value" })).value === "Ab中");
  check("Enter submits the form natively", (await call("eval", { expression: "document.querySelector('#form').dataset.submitted" })).value === "true");
  check("covered element is not pressed", /target_obscured: covered by span#overlay/.test((await call("click", { selector: "#covered" })).error) && (await call("eval", { expression: "String(document.querySelector('#covered').dataset.clicked)" })).value === "undefined");
  check("scoped click cannot escape scope", /target_not_found/.test((await call("click", { selector: "#go", scope: "#shadow" })).error));
  check("scoped type cannot escape scope", /target_not_found/.test((await call("type", { selector: "#account", scope: "#shadow", text: "wrong" })).error));
  check("legacy elements", (await call("elements", { limit: 2 })).count === 2);
  check("legacy eval", (await call("eval", { expression: "document.querySelector('#go').dataset.clicked" })).value === "yes");
  check("bounds", (await call("snapshot", { frameId: "all", limit: 1 })).truncated);
  // Exercise the same AgentSession/ToolRouter entry used by external MCP, not
  // just a separately constructed PageBackend. Fail before metadata fallback.
  await wire.execute('return !!ChromeUtils.importESModule("resource:///modules/agentsidebar/Backends.sys.mjs").getBackends().page;');
  const catalog = await wire.execute(JS_TOOLS);
  check("73 live browser tools", catalog.count === 73 && catalog.missingDeclared.length === 0);
  const routed = await wire.executeAsync(JS_CALLTOOL, ["page_find", { role: "button", name: "Continue" }, null]);
  check("MCP dispatch semantic query", routed.ok && routed.data?.count === 1);
  const clicked = await wire.executeAsync(JS_CALLTOOL, ["page_click", { ref: routed.data.elements[0].ref }, null]);
  check("MCP dispatch reference click", clicked.ok);
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  const tool = (name, args) => wire.executeAsync(JS_CALLTOOL, [name, args, workspace]);
  check("Agent workspace write", (await tool("fs_write", { path: "work/probe.txt", content: "agent-workspace-ok" })).ok);
  check("Agent workspace read", (await tool("fs_read", { path: "work/probe.txt" })).data?.content === "agent-workspace-ok");
  const node = await tool("run_node", { code: "console.log(require('fs').readFileSync('work/probe.txt','utf8'))" });
  assert(node.ok && node.data?.exitCode === 0 && node.data.output.includes("agent-workspace-ok"), `Agent Node tool: ${JSON.stringify(node)}`);
  checks.push("Agent Node execution");
  const origin = `http://127.0.0.1:${server.address().port}`;
  check("Agent network capture starts", (await tool("net_capture", { action: "start", urlPattern: origin + "/*", captureBody: false })).ok);
  try {
    check("Agent fetch", (await call("eval", { expression: `fetch(${JSON.stringify(origin + "/network-smoke")}).then(r=>r.status)` })).value === 200);
    let network;
    for (let i = 0; i < 30; i++) {
      network = await tool("net_list", { urlPattern: origin + "/network-smoke", limit: 10 });
      if (network.data?.requests?.some(r => r.status === 200)) break;
      await delay(100);
    }
    check("Agent captured network response", network.data?.requests?.some(r => r.status === 200));
  } finally {
    check("Agent network capture stops", (await tool("net_capture", { action: "stop" })).ok);
  }
  // Offline replay: record with bodies once, then answer from the recording while the server has moved on.
  const fetchText = async url => (await call("eval", { expression: `fetch(${JSON.stringify(url)}).then(r=>r.text(),e=>"blocked:"+e.name)` })).value;
  check("Agent capture with bodies starts", (await tool("net_capture", { action: "start", urlPattern: origin + "/replay/*", captureBody: true })).ok);
  check("live response before recording", await fetchText(origin + "/replay/data") === "live-1 /replay/data 签名");
  let recorded;
  let lastSeen;
  for (let i = 0; i < 30 && !recorded; i++) {
    const listed = (await tool("net_list", { urlPattern: origin + "/replay/data", limit: 5 })).data?.requests || [];
    for (const entry of listed) {
      lastSeen = await tool("net_get", { requestId: String(entry.id), includeBody: true });
      const detail = lastSeen.data?.request;
      if (detail?.responseBody?.text === "live-1 /replay/data 签名" && detail.responseBody.complete) recorded = detail;
    }
    if (!recorded) await delay(100);
  }
  assert(recorded, `Agent captured the decoded response body: ${JSON.stringify(lastSeen?.data?.request?.responseBody)}`);
  checks.push("Agent captured the decoded response body");
  await tool("net_capture", { action: "stop" });
  replayServer.live = "live-2";
  replayServer.hits = 0;
  const replaying = await tool("net_replay", { action: "start", urlPattern: origin + "/replay/*" });
  check("replay starts from the capture", replaying.ok && replaying.data?.entries >= 1);
  check("replay answers from the recording without the network", await fetchText(origin + "/replay/data") === "live-1 /replay/data 签名" && replayServer.hits === 0);
  check("replay blocks an unrecorded request", (await fetchText(origin + "/replay/other")).startsWith("blocked:") && replayServer.hits === 0);
  const decisions = (await tool("net_replay", { action: "log" })).data?.decisions?.map(d => d.decision) || [];
  check("replay log records each decision", decisions.includes("replayed") && decisions.includes("blocked"));
  check("replay saves a HAR in the workspace", (await tool("net_replay", { action: "save", path: "work/replay.har", urlPattern: origin + "/replay/*" })).ok
    && JSON.parse(await fs.readFile(path.join(workspace, "work/replay.har"), "utf8")).log.entries.length >= 1);
  await tool("net_replay", { action: "stop" });
  check("replay from the HAR", (await tool("net_replay", { action: "start", source: "har", harPath: "work/replay.har" })).ok
    && await fetchText(origin + "/replay/data") === "live-1 /replay/data 签名" && replayServer.hits === 0);
  check("replay stops", (await tool("net_replay", { action: "stop" })).ok);
  check("network is live again after replay", await fetchText(origin + "/replay/data") === "live-2 /replay/data 签名" && replayServer.hits === 1);
  const image = await call("screenshot");
  check("screenshot dimensions", image.width > 100 && image.height > 100 && image.coordinateSpace === "top-viewport-css");
  if (options.includes("--screenshot")) await fs.writeFile(option("--screenshot"), Buffer.from(image._media[0].dataUrl.split(",")[1], "base64"));
  await wire.command("Marionette:SetContext", { value: "content" });
  await wire.command("WebDriver:Navigate", { url: "about:blank" });
  await wire.command("Marionette:SetContext", { value: "chrome" });
  check("navigation invalidates ref", /stale_ref/.test((await call("click", { ref: topButton.ref })).error));
  // page_determinism: with one seed every new document starts the same Math.random and crypto sequences, exactly as
  // the Node replica computes them, through the JIT, in frames and after a cross-site (cross-process) navigation.
  const visit = async url => {
    await wire.command("Marionette:SetContext", { value: "content" });
    await wire.command("WebDriver:Navigate", { url });
    await wire.command("Marionette:SetContext", { value: "chrome" });
  };
  const BURN = 50000;
  const pageValues = async () => JSON.parse((await call("eval", { expression: `JSON.stringify({...window.__determinism,burn:window.__burn(${BURN})})` })).value);
  const frameValues = async () => {
    for (let i = 0; i < 50; i++) {
      const value = (await call("eval", { expression: "JSON.stringify(document.querySelector('iframe')?.contentWindow?.__determinism ?? null)" })).value;
      if (value !== "null") return JSON.parse(value);
      await delay(100);
    }
    return null;
  };
  check("determinism starts", (await tool("page_determinism", { action: "start", seed: "frx-verify" })).data?.active === true);
  check("determinism writes the Node replica", (await tool("page_determinism", { action: "replica" })).data?.saved === "work/determinism-replica.cjs");
  const { seeded } = createRequire(import.meta.url)(path.join(workspace, "work/determinism-replica.cjs"));
  const expected = (() => {
    const r = seeded("frx-verify");
    const first = { random: [r.random(), r.random(), r.random()], bytes: Array.from(r.getRandomValues(new Uint8Array(12))), uuid: r.randomUUID() };
    let burn = 0;
    for (let i = 0; i < BURN; i++) burn += r.random();
    return { ...first, burn };
  })();
  await visit(`${origin}/determinism`);
  const seededPage = await pageValues();
  check("seeded document matches the Node replica", JSON.stringify(seededPage) === JSON.stringify(expected));
  check("seeded frame starts the same sequence", JSON.stringify(await frameValues()) === JSON.stringify({ random: expected.random, bytes: expected.bytes, uuid: expected.uuid }));
  check("Math.random stays native", /\[native code\]/.test((await call("eval", { expression: "window.Math.random.toString()" })).value));
  check("page_eval has its own Math", (await call("eval", { expression: "Math.random === window.Math.random" })).value === false);
  await visit(`${origin}/determinism`);
  check("reload repeats the sequence", JSON.stringify(await pageValues()) === JSON.stringify(expected));
  await visit(`${origin.replace("127.0.0.1", "localhost")}/determinism`);
  check("cross-site navigation stays seeded", JSON.stringify(await pageValues()) === JSON.stringify(expected));
  check("determinism status", (await tool("page_determinism", { action: "status" })).data?.seed === "frx-verify");
  // The seed is hashed as UTF-8 on both sides.
  check("determinism restarts with a new seed", (await tool("page_determinism", { action: "start", seed: "签名-seed" })).data?.seed === "签名-seed");
  await visit(`${origin}/determinism`);
  const utf8 = seeded("签名-seed");
  const utf8Page = await pageValues();
  check("UTF-8 seed matches the Node replica", JSON.stringify({ random: utf8Page.random, bytes: utf8Page.bytes, uuid: utf8Page.uuid })
    === JSON.stringify({ random: [utf8.random(), utf8.random(), utf8.random()], bytes: Array.from(utf8.getRandomValues(new Uint8Array(12))), uuid: utf8.randomUUID() }));
  check("determinism stops", (await tool("page_determinism", { action: "stop" })).data?.active === false);
  await visit(`${origin}/determinism`);
  const unseeded = await pageValues();
  check("real randomness after stop", unseeded.uuid !== expected.uuid && unseeded.random[0] !== expected.random[0]);
  const result = { buildID: identity.buildID, xulSHA256: hash, checks, limitations: ["Synthetic fixtures, not third-party website acceptance", "Closed shadow roots unsupported"] };
  if (options.includes("--output")) await fs.writeFile(option("--output"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (wire) {
    await wire.command("Marionette:SetContext", { value: "chrome" }).catch(() => {});
    await wire.execute('Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);').catch(() => {});
    await wire.close();
  }
  for (let i = 0; i < 50 && proc.exitCode === null && proc.signalCode === null; i++) await delay(100);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i++) await delay(100);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
