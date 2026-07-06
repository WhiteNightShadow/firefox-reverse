import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "frx-env-selftest-"));

globalThis.PathUtils = {
  homeDir: os.homedir(),
  join: (...parts) => path.join(...parts),
  parent: p => path.dirname(p),
};

globalThis.IOUtils = {
  async makeDirectory(p, opts = {}) {
    await fs.mkdir(p, { recursive: !!opts.createAncestors || !!opts.ignoreExisting });
  },
  async exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async readJSON(p) {
    return JSON.parse(await fs.readFile(p, "utf8"));
  },
  async writeJSON(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(data, null, 2));
  },
  async writeUTF8(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, "utf8");
  },
  async remove(p, opts = {}) {
    await fs.rm(p, { recursive: !!opts.recursive, force: !!opts.ignoreAbsent });
  },
  async getChildren(p) {
    return (await fs.readdir(p)).map(name => path.join(p, name));
  },
};

globalThis.Services = {
  env: { get: () => "" },
  appinfo: { OS: "Darwin", version: "128.0" },
  prefs: {
    getIntPref: (_name, fallback) => fallback,
    getStringPref: (_name, fallback) => fallback,
  },
  dirsvc: { get: () => { throw new Error("dirsvc unavailable in selftest"); } },
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
    platform: "MacIntel",
    language: "en-US",
    languages: ["en-US", "en"],
    webdriver: false,
    hardwareConcurrency: 8,
  },
});
Object.defineProperty(globalThis, "screen", {
  configurable: true,
  value: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 875,
    colorDepth: 24,
    pixelDepth: 24,
  },
});
Object.defineProperty(globalThis, "devicePixelRatio", {
  configurable: true,
  value: 2,
});

try {
  const { EnvironmentBackend } = await import("../modules/EnvironmentBackend.sys.mjs");
  const backend = new EnvironmentBackend({ root });

  const created = await backend.create({ name: "Selftest" });
  const id = created.environment.id;
  assert.ok(id);

  const listed = await backend.list({ refresh: false });
  assert.equal(listed.count, 1);

  const renamed = await backend.update({ id, name: "Selftest Renamed" });
  assert.equal(renamed.environment.name, "Selftest Renamed");
  const renamedList = await backend.list({ refresh: false });
  assert.equal(renamedList.environments[0].name, "Selftest Renamed");

  globalThis.Services.env.get = name => (name === "MOZ_FRX_ENV_ID" ? id : "");
  const current = await backend.current({ refresh: false });
  assert.equal(current.id, id);
  assert.equal(current.environment.name, "Selftest Renamed");
  globalThis.Services.env.get = () => "";

  const fp1 = await backend.readConfig({ id, type: "fingerprint" });
  assert.equal(fp1.config.enabled, true);
  assert.equal(fp1.config.navigator.webdriver.value, false);

  const generated = await backend.generateFingerprint({
    id,
    options: {
      browser: "chromium",
      os: "linux",
      chromeVersion: "150.0.0.0",
      firefoxVersion: "128.0",
      language: "zh-CN",
      resolution: "1920x1080",
      timezone: "Asia/Shanghai",
      devicePixelRatio: 1,
      hardwareConcurrency: 12,
    },
  });
  assert.equal(generated.fingerprint.navigator.platform.value, "Linux x86_64");
  assert.match(generated.fingerprint.navigator.userAgent.value, /Chrome\/150\.0\.0\.0/);
  assert.equal(generated.fingerprint.navigator.vendor.value, "Google Inc.");
  assert.match(generated.fingerprint.http.secChUa.value, /Google Chrome/);
  assert.equal(generated.fingerprint.intl.timezone.value, "Asia/Shanghai");

  const captured = await backend.captureFingerprint({ id });
  assert.ok(captured.path.endsWith(".json"));

  const imported = await backend.importFingerprint({ id });
  assert.equal(imported.fingerprint.navigator.platform.value, "MacIntel");
  assert.equal(imported.fingerprint.window.devicePixelRatio.value, 2);

  await backend.writeConfig({ id, type: "proxy", config: { schemaVersion: 1, enabled: false, default: { type: "direct" } } });
  const proxy = await backend.readConfig({ id, type: "proxy" });
  assert.equal(proxy.config.default.type, "direct");

  const importedEnv = await backend.importEnvironment({
    text: JSON.stringify({
      name: "Imported JSON",
      fingerprint: generated.fingerprint,
      proxy: { schemaVersion: 1, enabled: false, default: { type: "direct" } },
    }),
  });
  assert.equal(importedEnv.created, true);
  assert.ok(importedEnv.environment.id);
  const importedFp = await backend.readConfig({ id: importedEnv.id, type: "fingerprint" });
  assert.match(importedFp.config.navigator.userAgent.value, /Chrome\/150\.0\.0\.0/);

  const overwritten = await backend.importEnvironment({
    id: importedEnv.id,
    name: "Imported JSON Renamed",
    overwrite: true,
    config: {
      fingerprint: {
        schemaVersion: 1,
        enabled: true,
        navigator: { platform: { enabled: true, value: "Win32" } },
      },
    },
  });
  assert.equal(overwritten.overwritten, true);
  assert.equal(overwritten.environment.name, "Imported JSON Renamed");

  await backend.delete({ id, confirm: true });
  await backend.delete({ id: importedEnv.id, confirm: true });
  const afterDelete = await backend.list({ refresh: false });
  assert.equal(afterDelete.count, 0);

  console.log("EnvironmentBackend selftest ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
