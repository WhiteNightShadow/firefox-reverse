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
  assert.equal(fp1.config.source.browser, "firefox");
  assert.match(fp1.config.navigator.userAgent.value, /Firefox\/128\.0/);
  assert.equal(fp1.config.navigator.language.value, "zh-CN");
  assert.equal(fp1.config.intl.timezone.value, "Asia/Shanghai");
  assert.equal(Object.hasOwn(fp1.config.navigator, "userAgentData"), false);
  assert.equal(Object.hasOwn(fp1.config.http, "secChUa"), false);

  const chineseRandom = await backend.generateFingerprint({
    id,
    options: { browser: "chromium", chromeVersion: "150.0.0.0", randomize: true },
  });
  assert.equal(chineseRandom.fingerprint.source.browser, "firefox");
  assert.match(chineseRandom.fingerprint.navigator.userAgent.value, /Firefox\/128\.0/);
  assert.doesNotMatch(chineseRandom.fingerprint.navigator.userAgent.value, /Chrome\//);
  assert.equal(chineseRandom.fingerprint.navigator.language.value, "zh-CN");
  assert.deepEqual(chineseRandom.fingerprint.navigator.languages.value, ["zh-CN", "zh", "en-US", "en"]);
  assert.equal(chineseRandom.fingerprint.intl.locale.value, "zh-CN");
  assert.equal(chineseRandom.fingerprint.intl.timezone.value, "Asia/Shanghai");
  assert.equal(chineseRandom.fingerprint.http.acceptLanguage.value, "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7");
  assert.equal(chineseRandom.fingerprint.source.options.region, "cn");

  const staleGlobalRequest = await backend.generateFingerprint({
    id,
    options: { browser: "chromium", randomize: true, region: "global" },
  });
  assert.equal(staleGlobalRequest.fingerprint.source.browser, "firefox");
  assert.equal(staleGlobalRequest.fingerprint.source.options.region, "cn");

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
  assert.equal(generated.fingerprint.source.browser, "firefox");
  assert.equal(generated.fingerprint.navigator.platform.value, "MacIntel");
  assert.match(generated.fingerprint.navigator.userAgent.value, /Firefox\/128\.0/);
  assert.equal(generated.fingerprint.navigator.vendor.value, "");
  assert.equal(Object.hasOwn(generated.fingerprint.navigator, "userAgentData"), false);
  assert.equal(Object.hasOwn(generated.fingerprint.http, "secChUa"), false);
  assert.equal(generated.fingerprint.intl.timezone.value, "Asia/Shanghai");

  const customLocale = await backend.generateFingerprint({
    id,
    options: {
      language: "en-GB",
      languages: ["en-GB", "en"],
      locale: "en-GB",
      timezone: "Europe/London",
    },
  });
  assert.equal(customLocale.fingerprint.source.browser, "firefox");
  assert.equal(customLocale.fingerprint.source.options.region, "custom");
  assert.equal(customLocale.fingerprint.navigator.language.value, "en-GB");
  assert.deepEqual(customLocale.fingerprint.navigator.languages.value, ["en-GB", "en"]);
  assert.equal(customLocale.fingerprint.intl.locale.value, "en-GB");
  assert.equal(customLocale.fingerprint.intl.timezone.value, "Europe/London");

  const captured = await backend.captureFingerprint({ id });
  assert.ok(captured.path.endsWith(".json"));

  const imported = await backend.importFingerprint({ id });
  assert.equal(imported.fingerprint.navigator.platform.value, "MacIntel");
  assert.equal(imported.fingerprint.window.devicePixelRatio.value, 2);
  assert.equal(imported.fingerprint.source.normalizedBrowser, "firefox");

  const importedChromeCapture = await backend.importFingerprint({
    id,
    capture: {
      navigator: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
        platform: "Win32",
        language: "zh-CN",
        languages: ["zh-CN", "zh"],
        vendor: "Google Inc.",
        userAgentData: { brands: [{ brand: "Google Chrome", version: "150" }] },
      },
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      window: { devicePixelRatio: 1 },
      intl: { locale: "zh-CN", timezone: "Asia/Shanghai" },
      http: { secChUa: '"Google Chrome";v="150"' },
      webgl: { vendor: "WebKit", renderer: "WebKit WebGL", unmaskedVendor: "Google Inc." },
    },
  });
  assert.equal(importedChromeCapture.fingerprint.source.capturedBrowser, "chromium");
  assert.equal(importedChromeCapture.fingerprint.source.normalizedBrowser, "firefox");
  assert.equal(importedChromeCapture.fingerprint.source.normalizedFromNonFirefox, true);
  assert.match(importedChromeCapture.fingerprint.navigator.userAgent.value, /Firefox\/128\.0/);
  assert.equal(importedChromeCapture.fingerprint.navigator.platform.value, "MacIntel");
  assert.equal(importedChromeCapture.fingerprint.navigator.vendor.value, "");
  assert.equal(Object.hasOwn(importedChromeCapture.fingerprint.navigator, "userAgentData"), false);
  assert.equal(Object.hasOwn(importedChromeCapture.fingerprint.http, "secChUa"), false);
  assert.equal(importedChromeCapture.fingerprint.webgl.vendor.value, "Mozilla");

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
  assert.match(importedFp.config.navigator.userAgent.value, /Firefox\/128\.0/);

  await assert.rejects(
    () => backend.importEnvironment({
      text: JSON.stringify({
        name: "Rejected Chrome JSON",
        fingerprint: {
          schemaVersion: 1,
          source: { browser: "chromium" },
          navigator: {
            userAgent: {
              enabled: true,
              value: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
            },
          },
        },
      }),
    }),
    /only accept Firefox fingerprint JSON/
  );

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

  const legacyRoot = path.join(root, "legacy-compatibility");
  const legacyBackend = new EnvironmentBackend({ root: legacyRoot });
  const legacyId = (await legacyBackend.create({ name: "Legacy Chrome Environment" })).environment.id;
  const legacyMetadata = await legacyBackend._loadEnv(legacyId);
  delete legacyMetadata.fingerprintPolicy;
  await legacyBackend._saveEnv(legacyMetadata);
  await legacyBackend.writeConfig({
    id: legacyId,
    type: "fingerprint",
    config: {
      schemaVersion: 1,
      enabled: true,
      source: { browser: "chromium", type: "historical" },
      navigator: {
        userAgent: { enabled: true, value: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36" },
        vendor: { enabled: true, value: "Google Inc." },
      },
    },
  });
  const legacyBefore = (await legacyBackend.readConfig({ id: legacyId, type: "fingerprint" })).config;
  const constrainedNew = await legacyBackend.create({
    name: "Firefox Only",
    generateOptions: { browser: "chromium", chromeVersion: "150.0.0.0", randomize: true },
  });
  const constrainedFingerprint = (await legacyBackend.readConfig({
    id: constrainedNew.environment.id,
    type: "fingerprint",
  })).config;
  const legacyOpenEnv = await legacyBackend._loadEnv(legacyId);
  const legacyRuntimeConfig = await legacyBackend._syncProfileRuntimeConfig(legacyOpenEnv);
  await legacyBackend._writeProfilePrefs(legacyOpenEnv, null, legacyRuntimeConfig);
  const legacyAfter = (await legacyBackend.readConfig({ id: legacyId, type: "fingerprint" })).config;
  assert.equal(constrainedFingerprint.source.browser, "firefox");
  assert.match(constrainedFingerprint.navigator.userAgent.value, /Firefox\/128\.0/);
  await assert.rejects(
    () => legacyBackend.writeConfig({
      id: constrainedNew.environment.id,
      type: "fingerprint",
      config: legacyBefore,
    }),
    /only accepts Firefox fingerprint configuration/
  );
  assert.deepEqual(legacyAfter, legacyBefore);

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

  const launchRoot = path.join(root, "windows-launch");
  const launchCalls = [];
  let launchStarted = false;
  let readyChecks = 0;
  let outputReads = 0;
  const launchProcess = {
    pid: 7331,
    exitCode: null,
    stdout: {
      async readString() {
        outputReads += 1;
        return outputReads === 1 ? "Firefox startup output\n" : "";
      },
    },
    kill() {},
  };
  const launchBackend = new EnvironmentBackend({
    root: launchRoot,
    firefoxBin: "C:\\Program Files\\Firefox Reverse\\firefox.exe",
    subprocess: {
      async pathSearch(command) {
        return `C:\\Windows\\System32\\${command}`;
      },
      async call(spec) {
        launchCalls.push(spec);
        launchStarted = true;
        return launchProcess;
      },
    },
    portProbe: async () => true,
    portReadyProbe: async () => {
      readyChecks += 1;
      return launchStarted && readyChecks >= 2;
    },
    startupTimeoutMs: 100,
    startupPollMs: 1,
  });
  const launchEnv = (await launchBackend.create({ name: "Windows Launch" })).environment;
  const opened = await launchBackend.open({ id: launchEnv.id });
  assert.equal(opened.marionetteReady, true);
  assert.equal(opened.environment.runtime.status, "running");
  assert.equal(opened.environment.runtime.marionetteStatus, "ready");
  assert.equal(opened.environment.runtime.pid, 7331);
  assert.deepEqual(opened.originalArgs.slice(0, 4), ["-marionette", "-remote-allow-system-access", "-no-remote", "-profile"]);
  assert.equal(opened.originalArgs.includes("--marionette-port"), false);
  assert.equal(opened.launchEnvironment.MOZ_MARIONETTE, "1");
  assert.deepEqual(JSON.parse(opened.launchEnvironment.MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS), {
    "marionette.port": 2829,
  });
  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0].command, "C:\\Program Files\\Firefox Reverse\\firefox.exe");
  assert.ok(outputReads >= 2);
  assert.match(launchBackend._procOutputTails.get(launchEnv.id), /Firefox startup output/);

  let failedOutputReads = 0;
  const failedLaunchBackend = new EnvironmentBackend({
    root: path.join(root, "windows-launch-failed"),
    firefoxBin: "C:\\Program Files\\Firefox Reverse\\firefox.exe",
    subprocess: {
      async call() {
        return {
          pid: 7332,
          exitCode: 1,
          stdout: {
            async readString() {
              failedOutputReads += 1;
              return failedOutputReads === 1 ? "Firefox startup failed\n" : "";
            },
          },
          kill() {},
        };
      },
    },
    portProbe: async () => true,
    portReadyProbe: async () => false,
    startupTimeoutMs: 100,
    startupPollMs: 1,
  });
  const failedLaunchEnv = (await failedLaunchBackend.create({ name: "Failed Windows Launch" })).environment;
  await assert.rejects(
    () => failedLaunchBackend.open({ id: failedLaunchEnv.id }),
    /Firefox startup failed/
  );
  const failedStatus = await failedLaunchBackend.status({ id: failedLaunchEnv.id });
  assert.equal(failedStatus.environment.runtime.status, "stopped");
  assert.equal(failedStatus.environment.runtime.marionetteStatus, "process-exited");
  assert.equal(failedStatus.environment.runtime.stopReason, "process-exited-before-marionette");
  Services.appinfo.OS = "Darwin";

  await backend.delete({ id, confirm: true });
  await backend.delete({ id: importedEnv.id, confirm: true });
  const afterDelete = await backend.list({ refresh: false });
  assert.equal(afterDelete.count, 0);

  console.log("EnvironmentBackend selftest ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
