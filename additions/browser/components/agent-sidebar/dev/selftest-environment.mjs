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

  const windowsRoot = path.join(root, "windows-runtime");
  const commandSearches = [];
  const commandCalls = [];
  let tasklistMode = "alive";
  const outputProcess = (output, exitCode = 0) => {
    let sent = false;
    return {
      stdout: {
        async readString() {
          if (sent) {
            return "";
          }
          sent = true;
          return output;
        },
      },
      async wait() {
        return { exitCode };
      },
    };
  };
  const fakeSubprocess = {
    async pathSearch(command) {
      commandSearches.push(command);
      return `C:\\Windows\\System32\\${command}`;
    },
    async call(spec) {
      commandCalls.push(spec);
      if (spec.command.endsWith("taskkill.exe")) {
        return outputProcess("SUCCESS", 0);
      }
      if (tasklistMode === "error") {
        throw new Error("tasklist unavailable");
      }
      if (tasklistMode === "alive") {
        return outputProcess('"firefox.exe","4242","Console","1","100,000 K"\r\n', 0);
      }
      return outputProcess("INFO: No tasks are running which match the specified criteria.\r\n", 0);
    },
  };
  const externallyOccupiedPorts = new Set([2830]);
  const windowsBackend = new EnvironmentBackend({
    root: windowsRoot,
    subprocess: fakeSubprocess,
    portProbe: async port => !externallyOccupiedPorts.has(port),
  });
  Services.appinfo.OS = "WINNT";

  const winA = (await windowsBackend.create({ name: "Windows A" })).environment;
  const winB = (await windowsBackend.create({ name: "Windows B" })).environment;
  assert.equal(await windowsBackend._pidState(4242, winA.id), "alive");
  assert.equal(commandSearches.filter(x => x === "tasklist.exe").length, 1);
  assert.equal(commandCalls.at(-1).command, "C:\\Windows\\System32\\tasklist.exe");

  tasklistMode = "dead";
  assert.equal(await windowsBackend._pidState(9999, winA.id), "dead");
  tasklistMode = "error";
  assert.equal(await windowsBackend._pidState(6000, winA.id), "unknown");

  let winAEnv = await windowsBackend._loadEnv(winA.id);
  winAEnv.runtime = {
    ...winAEnv.runtime,
    status: "running",
    pid: 6000,
    marionettePort: 2829,
  };
  await windowsBackend._saveRuntime(winAEnv);
  const unknownRefresh = await windowsBackend._refreshRuntime(await windowsBackend._loadEnv(winA.id));
  assert.equal(unknownRefresh.runtime.status, "running");

  const tasklistCallsBeforeHandle = commandCalls.length;
  windowsBackend._procs.set(winA.id, { pid: 6000, exitCode: null });
  assert.equal(await windowsBackend._pidState(6000, winA.id), "alive");
  assert.equal(commandCalls.length, tasklistCallsBeforeHandle);

  winAEnv = await windowsBackend._loadEnv(winA.id);
  winAEnv.runtime.status = "stopped";
  winAEnv.runtime.pid = null;
  await windowsBackend._saveRuntime(winAEnv);
  const restoredFromHandle = await windowsBackend._refreshRuntime(await windowsBackend._loadEnv(winA.id));
  assert.equal(restoredFromHandle.runtime.status, "running");
  assert.equal(restoredFromHandle.runtime.pid, 6000);

  const allocated = await windowsBackend._allocatePort(await windowsBackend._loadEnv(winB.id));
  assert.equal(allocated, 2831);
  assert.equal(await windowsBackend._killPid(6000, { force: true }), true);
  assert.ok(commandSearches.includes("taskkill.exe"));
  assert.equal(commandCalls.at(-1).command, "C:\\Windows\\System32\\taskkill.exe");
  Services.appinfo.OS = "Darwin";

  await backend.delete({ id, confirm: true });
  await backend.delete({ id: importedEnv.id, confirm: true });
  const afterDelete = await backend.list({ refresh: false });
  assert.equal(afterDelete.count, 0);

  console.log("EnvironmentBackend selftest ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
