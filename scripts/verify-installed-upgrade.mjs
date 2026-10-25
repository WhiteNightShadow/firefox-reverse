#!/usr/bin/env node
// Acceptance check after an installed build was replaced in place. It runs against the maintainer's
// real profile, so only with the maintainer's consent: start the installed app with
// -marionette -remote-allow-system-access on --port first. Only counts and states are reported; no
// preference values, keys, bookmark titles or page data leave the browser. The one write is a
// temporary environment that is opened, closed through the quit channel and deleted again;
// --counts-only skips it, for a baseline taken with the old build before the upgrade.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const options = process.argv.slice(2);
const option = key => (options.includes(key) ? options[options.indexOf(key) + 1] : undefined);
assert(option("--port") && option("--mcp-root"), "usage: verify-installed-upgrade.mjs --port <marionette port> --mcp-root <frx-director-mcp> [--expect-version <x.y.z>] [--expect-build-id <id>] [--expect-profile <profile directory name>] [--counts-only] [--output <report.json>] [--quit]");
const { MarionetteWire } = await import(pathToFileURL(path.resolve(option("--mcp-root"), "dist/bridge/marionetteWire.js")));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs) => {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
  }
};

let wire;
// The wire's timeout is also its idle timeout, and opening an environment may take a while.
for (const deadline = Date.now() + 60000; ;) {
  wire = new MarionetteWire();
  try {
    await wire.connect("127.0.0.1", Number(option("--port")), 300000);
    break;
  } catch (error) {
    await wire.close();
    if (Date.now() > deadline) throw new Error(`Marionette is not reachable on port ${option("--port")}: ${error.message}`);
    await delay(500);
  }
}
const call = async (body, args = []) => {
  const value = await wire.executeAsync(`const done = arguments[arguments.length - 1];
    const args = Array.from(arguments).slice(0, -1);
    const { EnvironmentBackend } = ChromeUtils.importESModule("resource:///modules/agentsidebar/EnvironmentBackend.sys.mjs");
    const backend = () => (window.__frxUpgradeCheck ||= new EnvironmentBackend());
    (async () => { ${body} })().then(done, error => done({ upgradeCheckError: String(error), stack: error?.stack || "" }));`, args, 240000);
  if (value?.upgradeCheckError) throw new Error(`${value.upgradeCheckError}\n${value.stack}`);
  return value;
};
const counts = () => call(`
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const [row] = await (await PlacesUtils.promiseDBConnection()).execute("SELECT COUNT(*) AS n FROM moz_bookmarks WHERE type = 1");
  let modelProfiles = 0;
  try {
    const parsed = JSON.parse(Services.prefs.getStringPref("extensions.firefox-reverse.agent.modelProfiles.v1", "[]"));
    modelProfiles = Array.isArray(parsed) ? parsed.length : 0;
  } catch {}
  const list = await backend().list({ refresh: true });
  return {
    bookmarks: row.getResultByName("n"),
    modelProfiles,
    activeModelProfile: !!Services.prefs.getStringPref("extensions.firefox-reverse.agent.activeModelProfileId", ""),
    environments: list.count ?? (list.environments || []).length,
  };`);

const checks = [];
const failures = [];
const check = (label, value, detail) => (value ? checks.push(label) : failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`));
const report = {};
try {
  report.app = await call(`
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    let lastVersion = "";
    try { lastVersion = (await IOUtils.readUTF8(PathUtils.join(profile.path, "compatibility.ini"))).match(/^LastVersion=(.*)$/m)?.[1]?.trim() || ""; } catch {}
    return { buildID: Services.appinfo.appBuildID, version: Services.prefs.getStringPref("extensions.firefox-reverse.version", ""), profile: profile.leafName, lastVersion };`);
  if (option("--expect-version")) check("version preference matches the release", report.app.version === option("--expect-version"), report.app.version);
  if (option("--expect-build-id")) check("running build is the release", report.app.buildID === option("--expect-build-id"), report.app.buildID);
  if (option("--expect-profile")) check("the same profile is in use", report.app.profile === option("--expect-profile"), report.app.profile);
  check("the profile has been opened by this build", report.app.lastVersion.endsWith(`/${report.app.buildID}`), report.app.lastVersion);
  report.before = await counts();
  if (!options.includes("--counts-only")) {
    const id = await call(`return (await backend().create({ name: "安装检查（可删除）" })).environment.id;`);
    try {
      const opened = await call(`const o = await backend().open({ id: args[0], url: "about:blank" }); const r = o.environment?.runtime || {};
        return { launched: !!o.launched, status: r.status, pid: r.pid, controlDir: o.environment?.controlDir };`, [id]);
      check("a temporary environment opens", opened.launched && opened.status === "running", opened);
      check("its quit channel becomes ready", await waitFor(() => existsSync(path.join(opened.controlDir, "quit-channel.json")), 15000));
      const started = Date.now();
      const closed = await call(`const c = await backend().close({ id: args[0] }); const r = c.environment?.runtime || {}; return { ok: !!c.ok, error: c.error || null, closedBy: r.closedBy || null };`, [id]);
      report.temporaryEnvironment = { closedBy: closed.closedBy, closeMs: Date.now() - started };
      check("it closes through the quit channel", closed.ok && closed.closedBy === "quit-channel", closed);
    } finally {
      const deleted = await call(`const b = backend(); try { if ((await b.status({ id: args[0] })).environment.runtime.status !== "stopped") await b.close({ id: args[0] }); } catch {}
        return (await b.delete({ id: args[0], confirm: true })).ok;`, [id]).catch(error => String(error));
      check("the temporary environment is deleted", deleted === true, deleted);
    }
    report.after = await counts();
    check("bookmarks, model profiles and environments are unchanged", JSON.stringify(report.after) === JSON.stringify(report.before), { before: report.before, after: report.after });
  }
} finally {
  if (options.includes("--quit")) await wire.execute("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);").catch(() => {});
  await wire.close();
}

report.status = failures.length ? "failed" : "passed";
report.checks = checks;
report.failures = failures;
if (option("--output")) await fs.writeFile(option("--output"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
