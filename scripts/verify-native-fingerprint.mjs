#!/usr/bin/env node
// Runs page-owned probes in disposable profiles. Requires an explicit artifact
// hash; an installed older Firefox must never pass as the newly built engine.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeRenderingPrefs } from "../additions/browser/components/agent-sidebar/modules/NativeFingerprintPolicy.sys.mjs";
import { EnvironmentBackend } from "../additions/browser/components/agent-sidebar/modules/EnvironmentBackend.sys.mjs";
import { runNativeAudioProbe, compareNativeAudioMatrix } from "./tests/audio-probe.mjs";

const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firefox = option("--firefox");
const expectedHash = option("--xul-sha256");
const allowUnavailableWebgl = args.includes("--allow-unavailable-webgl");
const contextType = args.includes("--context-type") ? option("--context-type") : "tab";
assert(["tab", "window"].includes(contextType), "invalid context type");
assert(args.includes("--firefox") && args.includes("--xul-sha256") && /^[a-f0-9]{64}$/.test(expectedHash), "--firefox and --xul-sha256 are required");
const xul = firefox.endsWith(".app") ? path.join(firefox, "Contents/MacOS/XUL") : path.join(path.dirname(firefox), process.platform === "win32" ? "xul.dll" : "libxul.so");
const hash = createHash("sha256").update(await fs.readFile(xul)).digest("hex");
assert.equal(hash, expectedHash, "artifact binding mismatch");
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MOZ_FRX_") || key.startsWith("FRX_ENV_")) delete process.env[key];
}
delete process.env.MOZ_DISABLE_CONTENT_SANDBOX;
const mcp = args.includes("--mcp-root") ? option("--mcp-root") : path.join(root, "../frx-director-mcp");
const { ensureBrowser } = await import(pathToFileURL(path.join(mcp, "dist/launcher.js")));
const { MarionetteWire } = await import(pathToFileURL(path.join(mcp, "dist/bridge/marionetteWire.js")));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "frx-native-validation-"));
const report = { runtime: { firefox, xulSHA256: hash, platform: process.platform, arch: process.arch }, observations: {}, audio: {}, checks: [], limitations: ["Local synthetic fixtures only; no website acceptance or cross-hardware equivalence claim.", "Results apply only to this artifact and host. Complete display emulation remains unavailable."] };
const profiles = [];
report.runtime.contextType = contextType;
let renderingDefaults = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listening = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const freePort = async () => { const server = net.createServer(); await listening(server); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const check = (label, condition) => { report.checks.push({ label, passed: !!condition }); assert(condition, label); };

async function pageProbe(audioProbe, runAudio) {
  const identity = () => ({ ua: navigator.userAgent, appVersion: navigator.appVersion, platform: navigator.platform, language: navigator.language, languages: [...navigator.languages], hc: navigator.hardwareConcurrency, locale: Intl.DateTimeFormat().resolvedOptions().locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, winter: new Date("2026-01-15T12:00:00Z").getTimezoneOffset(), summer: new Date("2026-07-15T12:00:00Z").getTimezoneOffset(), uaData: typeof navigator.userAgentData });
  const workerURL = URL.createObjectURL(new Blob([`postMessage((${identity.toString()})())`], { type: "text/javascript" }));
  const worker = new Worker(workerURL);
  let timer;
  let workerValue;
  try { workerValue = await new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("worker timeout")), 8000); worker.onmessage = event => resolve(event.data); worker.onerror = () => reject(new Error("worker failed")); }); }
  finally { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(workerURL); }
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#efedf2"; ctx.fillRect(0, 0, 256, 96); ctx.fillStyle = "#256742"; ctx.font = "20px sans-serif"; ctx.fillText("FRX native 153", 8, 32); ctx.fillRect(13, 51, 27, 19);
  const initial = ctx.getImageData(0, 0, 256, 96);
  const bytesHash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  const clone = document.createElement("canvas"); clone.width = 256; clone.height = 96;
  clone.getContext("2d").drawImage(canvas, 0, 0);
  const copied = clone.getContext("2d").getImageData(0, 0, 256, 96);
  const exported = await createImageBitmap(await new Promise(resolve => canvas.toBlob(resolve, "image/png")));
  clone.getContext("2d").clearRect(0, 0, 256, 96); clone.getContext("2d").drawImage(exported, 0, 0); exported.close();
  const glCanvas = document.createElement("canvas");
  const gl = glCanvas.getContext("webgl", { antialias: true });
  const gpu = gl?.getExtension("WEBGL_debug_renderer_info");
  const glPixel = new Uint8Array(4);
  if (gl) { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, glPixel); }
  const fonts = {};
  for (const family of ["Arial", "Times New Roman"]) {
    try { await new FontFace(`Probe${family.replaceAll(" ", "")}`, `local("${family}")`).load(); fonts[family] = true; } catch { fonts[family] = false; }
  }
  return { page: identity(), worker: workerValue, headers: await (await fetch("/headers")).json(),
    display: { width: screen.width, height: screen.height, dpr: devicePixelRatio, innerWidth, innerHeight,
      deviceWidthCSS: matchMedia(`(device-width: ${screen.width}px)`).matches,
      deviceHeightCSS: matchMedia(`(device-height: ${screen.height}px)`).matches,
      resolutionCSS: matchMedia(`(resolution: ${devicePixelRatio}dppx)`).matches,
      viewportCSS: matchMedia(`(width: ${innerWidth}px)`).matches,
      deviceWidthRange: matchMedia(`(min-device-width: ${screen.width - 1}px) and (max-device-width: ${screen.width + 1}px)`).matches,
      deviceHeightRange: matchMedia(`(min-device-height: ${screen.height - 1}px) and (max-device-height: ${screen.height + 1}px)`).matches,
      viewportRange: matchMedia(`(min-width: ${innerWidth - 1}px) and (max-width: ${innerWidth + 1}px)`).matches,
      visualViewportWidth: visualViewport.width, visualViewportHeight: visualViewport.height, visualViewportScale: visualViewport.scale },
    canvas: { hash: await bytesHash(initial.data), repeated: await bytesHash(ctx.getImageData(0, 0, 256, 96).data), copy: await bytesHash(copied.data), png: await bytesHash(clone.getContext("2d").getImageData(0, 0, 256, 96).data) },
    webgl: gl ? { antialias: gl.getContextAttributes().antialias, vendor: gpu && gl.getParameter(gpu.UNMASKED_VENDOR_WEBGL), renderer: gpu && gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, bufferMatchesCanvas: gl.drawingBufferWidth === glCanvas.width && gl.drawingBufferHeight === glCanvas.height, pixel: [...glPixel] } : null,
    fonts, ...(runAudio ? { audio: await audioProbe() } : {}) };
}

const server = http.createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/headers") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ua: req.headers["user-agent"], languages: req.headers["accept-language"] })); return; }
  const runAudio = new URL(req.url, "http://localhost").searchParams.has("audio");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>FRX native validation</title><style>html,body{margin:0;overflow:hidden}body{background:#fafafa;font:16px sans-serif}pre{white-space:pre-wrap}</style><h2>Firefox Reverse native validation</h2><pre id="result"></pre><script>(${pageProbe.toString()})(${runNativeAudioProbe.toString()},${runAudio}).then(value=>document.querySelector('#result').textContent=JSON.stringify(value),error=>document.querySelector('#result').textContent=JSON.stringify({error:String(error)}))</script>`);
});
await listening(server);
const origin = `http://127.0.0.1:${server.address().port}`;

async function start(label, config, { inline, preferences = {}, profile: reuse } = {}) {
  const directory = reuse || path.join(temporary, label);
  await fs.mkdir(directory, { recursive: true });
  const configPath = path.join(directory, "环境-配置.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  const prefs = { "browser.startup.page": 0, "browser.startup.homepage": "about:blank", "browser.newtabpage.enabled": false, ...nativeRenderingPrefs(config, renderingDefaults), ...preferences };
  await fs.writeFile(path.join(directory, "user.js"), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  const port = await freePort();
  const owned = { label, directory, configPath, port, wire: new MarionetteWire(), pid: null };
  profiles.push(owned);
  const extraEnv = { MOZ_FRX_FINGERPRINT_CONFIG: configPath, MOZ_FRX_ENVS_ROOT: path.join(temporary, "manager-environments"), MOZ_FRX_ENV_ID: "owned-native-test", FRX_ENV_ID: "owned-native-test", ...(inline !== undefined ? { MOZ_FRX_FINGERPRINT_JSON: typeof inline === "string" ? inline : JSON.stringify(inline) } : {}) };
  if (process.platform === "win32") {
    // Native CI runs elevated. Keep ownership of this disposable test process
    // rather than allowing Firefox's de-elevation helper to detach it.
    owned.process = spawn(firefox, ["-no-remote", "-no-deelevate", "-wait-for-browser", "-profile", directory, "-marionette", "-remote-allow-system-access"], { env: { ...process.env, ...extraEnv, MOZ_MARIONETTE: "1", MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS: JSON.stringify({ "marionette.port": port }) }, stdio: ["ignore", "ignore", "pipe"] });
    owned.stderr = "";
    owned.process.stderr.on("data", chunk => { owned.stderr = (owned.stderr + chunk).slice(-4000); });
    owned.process.on("error", error => { owned.launchError = error; });
    const deadline = Date.now() + 90000;
    while (true) {
      if (owned.launchError || owned.process.exitCode !== null) throw new Error(`owned Windows launch failed: ${owned.launchError || owned.stderr}`);
      const ready = await new Promise(resolve => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false));
      });
      if (ready) break;
      if (Date.now() >= deadline) throw new Error("owned Windows launch timed out");
      await delay(250);
    }
  } else {
    await ensureBrowser({ host: "127.0.0.1", port, autolaunch: true, firefoxBin: firefox, profile: directory, portWaitSec: 90, extraEnv });
  }
  await owned.wire.connect("127.0.0.1", port, 90000);
  const actual = await owned.wire.execute('return {pid:Services.appinfo.processID,profile:Services.dirsvc.get("ProfD",Ci.nsIFile).path,version:Services.appinfo.version,os:Services.appinfo.OS,buildID:Services.appinfo.appBuildID};');
  check(`${label}:profile ownership`, await fs.realpath(actual.profile) === await fs.realpath(directory));
  owned.pid = actual.pid;
  report.runtime.buildID = actual.buildID;
  report.runtime.version = actual.version;
  report.runtime.os = actual.os;
  return owned;
}

async function sample(owned, label, { audio = false, legacyDisplay = false, crossSite = false } = {}) {
  const wire = owned.wire;
  await wire.command("Marionette:SetContext", { value: "content" });
  await wire.command("WebDriver:Navigate", { url: (crossSite ? origin.replace("127.0.0.1", "localhost") : origin) + (audio ? "/?audio" : "/") });
  const value = await wire.executeAsync(`const done=arguments[arguments.length-1]; (async()=>{for(let i=0;i<600;i++){const text=document.querySelector('#result')?.textContent;if(text)return JSON.parse(text);await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('page probe timeout');})().then(done,error=>done({error:String(error)}));`);
  report.observations[label] = value;
  check(`${label}:page probe`, value && !value.error);
  assert.deepEqual(value.page, value.worker, `${label}:page/worker identity`);
  check(`${label}:HTTP UA`, value.headers.ua === value.page.ua);
  const headerLanguages = String(value.headers.languages || "").split(",").map(item => item.split(";")[0].trim().toLowerCase());
  check(`${label}:HTTP languages`, JSON.stringify(headerLanguages) === JSON.stringify(value.page.languages.map(item => item.toLowerCase())));
  // screen/inner dimensions are rounded integers; Gecko MQs retain fractions
  // at noninteger zoom. Record exact matches, but allow <1 CSS px rounding.
  if (!legacyDisplay) for (const key of ["deviceWidthRange", "deviceHeightRange", "resolutionCSS", "viewportRange"]) check(`${label}:${key}`, value.display[key]);
  check(`${label}:Canvas copy/export`, [value.canvas.repeated, value.canvas.copy, value.canvas.png].every(hash => hash === value.canvas.hash));
  if (value.webgl || !allowUnavailableWebgl) check(`${label}:WebGL backing buffer`, value.webgl?.bufferMatchesCanvas && String(value.webgl.pixel) === "255,0,0,255");
  else if (!report.limitations.includes("WebGL unavailable on this runner; GPU/MSAA rendering unverified.")) report.limitations.push("WebGL unavailable on this runner; GPU/MSAA rendering unverified.");
  if (!legacyDisplay) {
    await wire.command("Marionette:SetContext", { value: "chrome" });
    value.chromeDisplay = await wire.execute('const win=Services.wm.getMostRecentWindow("navigator:browser");return {dpr:win.devicePixelRatio,zoom:win.gBrowser.selectedBrowser.fullZoom};');
    check(`${label}:page zoom/DPR`, Math.abs(value.display.dpr - value.chromeDisplay.dpr * value.chromeDisplay.zoom) < 0.001);
    await wire.command("Marionette:SetContext", { value: "content" });
    const screenshot = await wire.command("WebDriver:TakeScreenshot", { full: false });
    const png = Buffer.from(screenshot.value ?? screenshot, "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    value.screenshot = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    // Gecko Capture.sys.mjs uses the chrome window scale, not page zoom DPR.
    check(`${label}:screenshot pixels`, Math.abs(value.screenshot.width - value.display.innerWidth * value.chromeDisplay.dpr) <= 1 && Math.abs(value.screenshot.height - value.display.innerHeight * value.chromeDisplay.dpr) <= 1);
    await fs.writeFile(path.join(temporary, label.replaceAll(":", "-") + ".png"), png);
  }
  await wire.command("Marionette:SetContext", { value: "chrome" });
  value.contentPid = await wire.execute('return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.frameLoader.remoteTab.osPid;');
  const snapshot = await wire.execute(`const branch=Services.prefs.getDefaultBranch('');const header=JSON.parse(branch.getStringPref('frx.fingerprint.bootstrap.metadata'));let text='';for(let i=0;i<header.chunks;i++)text+=branch.getStringPref('frx.fingerprint.bootstrap.part.'+i);const data=JSON.parse(text);return {status:data.status,reason:data.reason,source:data.source,chunks:header.chunks};`);
  value.snapshot = snapshot;
  report.observations[label] = value;
  if (audio) report.audio[label] = value.audio;
  console.log(`PASS ${label}: ${snapshot.source}/${snapshot.reason}`);
  return value;
}

async function stop(owned) {
  if (!owned.pid) {
    if (owned.process?.pid && owned.process.exitCode === null) owned.process.kill();
    return;
  }
  try { await owned.wire.command("Marionette:Quit"); } catch {}
  await owned.wire.close();
  for (let i = 0; i < 100 && alive(owned.pid); i++) await delay(100);
  if (alive(owned.pid)) { process.kill(owned.pid, "SIGTERM"); for (let i = 0; i < 50 && alive(owned.pid); i++) await delay(100); }
  check(`${owned.label}:owned process stopped`, !alive(owned.pid));
  owned.pid = null;
  const persisted = await fs.readFile(path.join(owned.directory, "prefs.js"), "utf8");
  check(`${owned.label}:snapshot not persisted`, !persisted.includes("frx.fingerprint.bootstrap."));
}

async function setZoom(owned, zoom) {
  await owned.wire.command("Marionette:SetContext", { value: "chrome" });
  const applied = await owned.wire.executeAsync('const done=arguments[arguments.length-1];const win=Services.wm.getMostRecentWindow("navigator:browser");win.FullZoom.setZoom(arguments[0]);Promise.resolve(win.FullZoom._applyZoomToPref(win.gBrowser.selectedBrowser)).then(()=>done(true),error=>done({error:String(error)}));', [zoom]);
  check("native zoom applied", applied === true);
}

try {
  const baseline = await start("reference", { enabled: false });
  const reference = await sample(baseline, "reference", { audio: true });
  await setZoom(baseline, 1.25);
  await sample(baseline, "reference:zoom");
  renderingDefaults = await baseline.wire.execute('const branch=Services.prefs.getDefaultBranch("");return Object.fromEntries(Object.entries(arguments[0]).map(([key,value])=>{try{return [key,typeof value === "boolean" ? branch.getBoolPref(key) : typeof value === "number" ? branch.getIntPref(key) : branch.getStringPref(key)];}catch{return [key,value];}}));', [nativeRenderingPrefs({ enabled: false, consistency: { mode: "native-consistent", version: 1 } })]);
  const fonts = await baseline.wire.execute('return Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator).EnumerateAllFonts();');
  await stop(baseline);
  globalThis.Services = { appinfo: { OS: report.runtime.os, version: report.runtime.version }, env: { get: () => "" } };
  globalThis.PathUtils = { join: path.join };
  const backend = new EnvironmentBackend();
  const env = { seed: "test-only", audioSeed: "0".repeat(64), consistencyMode: "native-consistent", traceDir: path.join(temporary, "traces") };
  const config = backend._buildFingerprint(env, backend._firefoxGenerateOptions({ language: "en-US", languages: ["en-US", "en"], timezone: "America/New_York" }));
  config.fixturePadding = "x".repeat(9000);
  const legacy = structuredClone(config);
  delete legacy.consistency;
  legacy.navigator.appVersion = { enabled: true, value: "legacy-app-version" };
  legacy.screen = { enabled: true, width: { enabled: true, value: 1200 }, height: { enabled: true, value: 800 } };
  legacy.window = { devicePixelRatio: { enabled: true, value: 1 } };
  legacy.audio = { enabled: true, mode: "seeded", seed: "legacy-opaque-seed", noise: 0.1 };
  const old = await start("legacy", legacy);
  const oldValue = await sample(old, "legacy", { audio: true, legacyDisplay: true });
  check("legacy display and saved appVersion preserved", oldValue.display.width === 1200 && oldValue.display.height === 800 && oldValue.display.dpr === 1 && oldValue.page.appVersion === "legacy-app-version");
  check("legacy audio metadata not activated", oldValue.audio.rates[44100].sha256 === reference.audio.rates[44100].sha256);
  await stop(old);
  const other = structuredClone(config);
  other.navigator.language.value = "fr-FR"; other.navigator.languages.value = ["fr-FR", "fr"]; other.intl.locale.value = "fr-FR"; other.intl.timezone.value = "Europe/Paris"; other.http.acceptLanguage.value = "fr-FR,fr;q=0.9";
  const a = await start("file-A", config, { preferences: { "frx.fingerprint.config.json": JSON.stringify(other) } });
  const first = await sample(a, "file-A:first");
  check("explicit file wins profile JSON", first.page.language === "en-US" && first.snapshot.source === "environment-file-once");
  check("large parent snapshot", first.snapshot.chunks > 1);
  check("native appVersion", first.page.appVersion === reference.page.appVersion);
  check("native Screen/DPR", first.display.width === reference.display.width && first.display.dpr === reference.display.dpr);
  assert.deepEqual(first.webgl, reference.webgl);
  check("New York Date/Intl", first.page.timezone === "America/New_York" && first.page.winter === 300 && first.page.summer === 240);
  await fs.writeFile(a.configPath, JSON.stringify(other));
  await a.wire.execute('Services.prefs.setStringPref("frx.fingerprint.config.json", arguments[0]);', [JSON.stringify(other)]);
  await setZoom(a, 1.25);
  const zoom = await sample(a, "file-A:mutated-zoom");
  assert.deepEqual(zoom.page, first.page);
  check("zoom follows native DPR", zoom.display.dpr > first.display.dpr);
  await a.wire.command("Marionette:SetContext", { value: "content" });
  const opened = await a.wire.command("WebDriver:NewWindow", { type: contextType, focus: true });
  await a.wire.command("WebDriver:SwitchToWindow", { handle: (opened.value ?? opened).handle, focus: true });
  const fresh = await sample(a, "file-A:new-context", { crossSite: true });
  assert.deepEqual(fresh.page, first.page);
  check("fresh content process uses original parent snapshot", fresh.contentPid !== first.contentPid);
  await stop(a);
  const restarted = await start("file-A-restart", other, { profile: a.directory });
  const changed = await sample(restarted, "file-A:restart");
  check("file reread on parent restart", changed.page.language === "fr-FR" && changed.page.timezone === "Europe/Paris");
  await stop(restarted);
  const inline = await start("inline-A", other, { inline: config });
  check("inline wins explicit file", (await sample(inline, "inline-A")).page.language === "en-US");
  await stop(inline);
  const invalid = await start("invalid", config, { inline: "" });
  const invalidValue = await sample(invalid, "invalid");
  check("empty explicit input does not fall back", invalidValue.snapshot.status === 2 && invalidValue.page.ua === reference.page.ua && invalidValue.page.timezone === reference.page.timezone);
  await stop(invalid);
  const seeded = structuredClone(config); seeded.audio.mode.value = "seeded"; seeded.audio.seed.enabled = true;
  seeded.canvas.backend.value = "software"; seeded.webgl.msaaSamples = { enabled: true, value: 0 };
  const audioA = await start("audio-A", seeded);
  const audioFirst = await sample(audioA, "A:page:first", { audio: true });
  if (audioFirst.webgl || !allowUnavailableWebgl) check("real WebGL MSAA disabled", audioFirst.webgl?.antialias === false);
  check("real Canvas software preference", await audioA.wire.execute('return Services.prefs.getBoolPref("gfx.canvas.accelerated") === false;'));
  await stop(audioA);
  const audioRestart = await start("audio-A-restart", seeded, { profile: audioA.directory });
  await sample(audioRestart, "A:page:restart", { audio: true }); await stop(audioRestart);
  seeded.audio.seed.value = "f".repeat(64);
  const audioB = await start("audio-B", seeded);
  await sample(audioB, "B:page:first", { audio: true }); await stop(audioB);
  report.audioMatrix = compareNativeAudioMatrix(report.audio, { requireSeedEffect: true });
  check("Offline Audio relations and seed effect", report.audioMatrix.passed);
  if (fonts.includes("Arial") && fonts.includes("Times New Roman") && reference.fonts["Times New Roman"]) {
    const restricted = structuredClone(config); restricted.fonts = { enabled: true, mode: { value: "allowlist", enabled: true }, families: { value: ["Arial"], enabled: true } };
    const fontEnv = await start("fonts", restricted);
    const observed = await sample(fontEnv, "fonts");
    if (process.platform === "darwin") check("installed allowlisted local font works", observed.fonts.Arial);
    else report.limitations.push("Non-macOS keeps Firefox's native local() fallback policy under a font allowlist.");
    check("excluded local font uses fallback", !observed.fonts["Times New Roman"]);
    await stop(fontEnv);
  } else report.limitations.push("Arial/Times local font allowlist fixture unavailable on this host.");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || String(error); process.exitCode = 1;
} finally {
  for (const owned of profiles) { try { await stop(owned); } catch (error) { report.cleanupError = String(error); process.exitCode = 1; } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const reportPath = path.join(temporary, "observations.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  if (args.includes("--report-output")) {
    const output = path.resolve(option("--report-output"));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, reportPath, error: report.error || report.cleanupError || null }));
}
