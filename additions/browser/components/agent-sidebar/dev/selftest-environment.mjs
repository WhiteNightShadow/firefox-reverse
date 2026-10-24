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
  async readUTF8(p) {
    return fs.readFile(p, "utf8");
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
  assert.equal(fp1.config.consistency.mode, "native-consistent");
  assert.equal(fp1.config.screen.enabled, false);
  assert.equal(fp1.config.screen.width.enabled, false);
  assert.equal(fp1.config.window.devicePixelRatio.enabled, false);
  assert.equal(fp1.config.webgl.unmaskedRenderer.enabled, false);
  assert.equal(fp1.config.navigator.appVersion.value, "5.0 (Macintosh)");
  assert.equal(fp1.config.navigator.userAgent.enabled, false);
  assert.equal(fp1.config.navigator.appVersion.enabled, false);
  const originalConfigBytes = await fs.readFile(fp1.path, "utf8");
  const invalidDisplay = structuredClone(fp1.config);
  invalidDisplay.screen.enabled = true;
  invalidDisplay.screen.width.enabled = true;
  await assert.rejects(backend.writeConfig({ id, config: invalidDisplay }), /display simulation/);
  assert.equal(await fs.readFile(fp1.path, "utf8"), originalConfigBytes);
  const seed = fp1.config.audio.seed.value;
  const nativeAudio = structuredClone(fp1.config);
  nativeAudio.audio.mode.value = "seeded";
  nativeAudio.audio.seed.enabled = true;
  nativeAudio.canvas.backend.value = "software";
  nativeAudio.webgl.msaaSamples = { enabled: true, value: 0 };
  await backend.writeConfig({ id, config: nativeAudio });
  const savedPrefs = await fs.readFile(path.join(created.environment.profilePath, "user.js"), "utf8");
  assert.match(savedPrefs, /user_pref\("frx.fingerprint.config.json", ""\)/);
  assert.match(savedPrefs, /user_pref\("gfx.canvas.accelerated", false\)/);
  assert.match(savedPrefs, /user_pref\("webgl.msaa-samples", 0\)/);
  assert.match(savedPrefs, /user_pref\("media.cubeb.force_sample_rate", 0\)/);
  assert.equal((await backend.readConfig({ id })).config.audio.seed.value, seed);
  await backend.writeConfig({ id, config: fp1.config });
  assert.match(await fs.readFile(path.join(created.environment.profilePath, "user.js"), "utf8"), /user_pref\("gfx.canvas.accelerated", true\)/);
  const backToLegacy = structuredClone(fp1.config);
  delete backToLegacy.consistency;
  await backend.writeConfig({ id, config: backToLegacy });
  const storedEnv = await backend._loadEnv(id);
  await backend._stageEnvironmentConfig(storedEnv);
  const legacyPrefs = await fs.readFile(path.join(created.environment.profilePath, "user.js"), "utf8");
  assert.match(legacyPrefs, /user_pref\("gfx.canvas.accelerated", true\)/);
  assert.match(legacyPrefs, /user_pref\("font.system.whitelist", ""\)/);
  await backend.writeConfig({ id, config: fp1.config });
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
  let powershellCommandLine = null;
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
      if (spec.command.endsWith("powershell.exe")) {
        if (powershellCommandLine === null) {
          throw new Error("powershell unavailable");
        }
        return outputProcess(powershellCommandLine, 0);
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

  // 发信号前的严格核对：Firefox 自己就有很多 firefox.exe 子进程，映像名对得上还要看命令行里的 profile。
  windowsBackend._procs.delete(winA.id);
  tasklistMode = "alive";
  const strictEnv = await windowsBackend._loadEnv(winA.id);
  powershellCommandLine = `"C:\\Program Files\\Firefox Reverse\\firefox.exe" -marionette -profile C:\\Users\\白夜\\.firefox-reverse\\environments\\${winA.id}\\profile\r\n`;
  assert.equal(await windowsBackend._pidState(4242, winA.id, strictEnv, { strict: true }), "alive");
  powershellCommandLine = '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -contentproc -childID 3 -isForBrowser\r\n';
  assert.equal(await windowsBackend._pidState(4242, winA.id, strictEnv, { strict: true }), "dead", "another Firefox's child process is not this environment");
  assert.equal(await windowsBackend._pidState(4242, winA.id, strictEnv), "alive", "status refresh stays on the cheap image check");
  strictEnv.runtime = { ...strictEnv.runtime, status: "running", pid: 4242, marionettePort: 2829 };
  await windowsBackend._saveRuntime(strictEnv);
  const killsBefore = commandCalls.filter(spec => spec.command.endsWith("taskkill.exe")).length;
  const reusedWin = await windowsBackend.close({ id: winA.id });
  assert.equal(reusedWin.environment.runtime.stopReason, "process-not-found");
  powershellCommandLine = null;
  strictEnv.runtime = { ...strictEnv.runtime, status: "running", pid: 4242, marionettePort: 2829 };
  await windowsBackend._saveRuntime(strictEnv);
  const unverifiable = await windowsBackend.close({ id: winA.id });
  assert.equal(unverifiable.ok, false, "identity cannot be verified");
  assert.equal(unverifiable.environment.runtime.status, "running");
  assert.equal(commandCalls.filter(spec => spec.command.endsWith("taskkill.exe")).length, killsBefore, "no taskkill without a verified identity");

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
  assert.deepEqual(opened.originalArgs.slice(0, 5), ["-marionette", "-remote-allow-system-access", "-no-remote", "-new-instance", "-profile"]);
  assert.equal(opened.originalArgs.includes("--marionette-port"), false);
  assert.equal(opened.launchEnvironment.MOZ_MARIONETTE, "1");
  assert.equal("MOZ_FRX_PROXY_JSON" in opened.launchEnvironment, false);
  assert.equal(launchCalls[0].environment.MOZ_FRX_PROXY_JSON, null);
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

  // ── 指纹静默失效：与 C++ 硬约束一致、native TLS 复位、关闭覆盖仍隐藏 webdriver、主浏览器代理不被改写 ──
  const contractBase = (await backend.readConfig({ id, type: "fingerprint" })).config;
  await assert.rejects(
    backend.writeConfig({ id, config: { intl: { enabled: true, locale: { enabled: true, value: "zh-CN" } } } }),
    /enabled must be boolean/
  );
  const badPolicy = structuredClone(contractBase);
  badPolicy.consistency = { mode: "legacy" };
  await assert.rejects(backend.writeConfig({ id, config: badPolicy }), /consistency version/);

  const nativeTls = structuredClone(contractBase);
  nativeTls.tls = { enabled: true, zeroRtt: false, echGrease: true };
  const nativeTlsPrefs = backend._fingerprintUserPrefs(nativeTls).join("\n");
  assert.match(nativeTlsPrefs, /user_pref\("security.tls.enable_0rtt_data", true\)/);
  assert.match(nativeTlsPrefs, /user_pref\("network.http.http3.enable_0rtt", true\)/);
  assert.match(nativeTlsPrefs, /user_pref\("security.tls.grease_http3_enable", false\)/);
  const legacyTls = structuredClone(contractBase);
  legacyTls.consistency = { mode: "legacy", version: 1 };
  legacyTls.tls = { echGrease: true };
  const legacyTlsPrefs = backend._fingerprintUserPrefs(legacyTls).join("\n");
  assert.match(legacyTlsPrefs, /user_pref\("security.tls.ech.grease_http3", true\)/);
  assert.match(legacyTlsPrefs, /user_pref\("security.tls.grease_http3_enable", false\)/);
  legacyTls.tls.http3Grease = true;
  assert.match(backend._fingerprintUserPrefs(legacyTls).join("\n"), /user_pref\("security.tls.grease_http3_enable", true\)/);

  const disabledFp = structuredClone(contractBase);
  disabledFp.enabled = false;
  await backend.writeConfig({ id, config: disabledFp });
  const disabledEnv = await backend._loadEnv(id);
  const disabledRuntime = await backend._syncProfileRuntimeConfig(disabledEnv);
  const hiddenWebdriver = { enabled: true, navigator: { webdriver: { enabled: true, value: false } } };
  assert.deepEqual(disabledRuntime.engineFingerprint, hiddenWebdriver);
  assert.equal(disabledRuntime.fingerprint.enabled, false);
  assert.deepEqual(JSON.parse(await fs.readFile(disabledRuntime.fingerprintPath, "utf8")), hiddenWebdriver);
  const disabledUserJs = backend._profileUserJs(disabledEnv, 2900, disabledRuntime);
  const enginePref = disabledUserJs.match(/user_pref\("frx.fingerprint.config.json", (".*")\);/);
  assert.deepEqual(JSON.parse(JSON.parse(enginePref[1])), hiddenWebdriver);
  assert.doesNotMatch(disabledUserJs, /media\.peerconnection\.ice\.no_host/, "disabled overrides must not add WebRTC prefs");
  await backend.writeConfig({ id, config: contractBase });

  const mainProfile = path.join(root, "main-profile");
  await fs.mkdir(mainProfile, { recursive: true });
  await fs.writeFile(path.join(mainProfile, "user.js"), [
    'user_pref("network.proxy.type", 5);',
    "// >>> Firefox Reverse current-process fingerprint prefs",
    'user_pref("network.proxy.no_proxies_on", "localhost,127.0.0.1,::1");',
    'user_pref("network.proxy.type", 0);',
    "// <<< Firefox Reverse current-process fingerprint prefs",
    "",
  ].join("\n"));
  const clearedPrefs = [];
  const savedPrefs0 = { ...Services.prefs };
  Object.assign(Services.prefs, {
    prefHasUserValue: () => true,
    clearUserPref: name => clearedPrefs.push(name),
    setStringPref() {},
    setBoolPref() {},
    getBoolPref: (_name, fallback) => fallback,
  });
  globalThis.Ci = { nsIFile: {} };
  Services.dirsvc.get = () => ({ path: mainProfile });
  try {
    const mainFp = (await backend.readCurrentProcessConfig({ type: "fingerprint" })).config;
    mainFp.enabled = true;
    await backend.writeCurrentProcessConfig({ type: "fingerprint", config: mainFp });
    const mainUserJs = await fs.readFile(path.join(mainProfile, "user.js"), "utf8");
    assert.equal(mainUserJs.match(/network\.proxy\.type/g).length, 1, "only the user's own proxy line remains");
    assert.match(mainUserJs, /user_pref\("network.proxy.type", 5\);/);
    assert.ok(clearedPrefs.includes("network.proxy.type") && clearedPrefs.includes("network.proxy.no_proxies_on"), "stale direct-proxy prefs from the old block are cleared");
  } finally {
    Services.dirsvc.get = () => { throw new Error("dirsvc unavailable in selftest"); };
    delete globalThis.Ci;
    for (const key of Object.keys(Services.prefs)) {
      if (!(key in savedPrefs0)) {
        delete Services.prefs[key];
      }
    }
    Object.assign(Services.prefs, savedPrefs0);
  }

  // ── 进程管理与并发：索引一致、只落 runtime、端口不撞、同环境不重复启动、关闭先优雅后强杀、PID 复用不误杀 ──
  const lockRoot = path.join(root, "locking");
  const lockBackend = new EnvironmentBackend({ root: lockRoot });
  const many = await Promise.all(Array.from({ length: 6 }, (_, i) => lockBackend.create({ name: `Concurrent ${i}` })));
  assert.equal((await lockBackend.list({ refresh: false })).count, 6, "concurrent creates must not lose manifest entries");
  const [keep, gone] = [many[0].environment.id, many[1].environment.id];
  await Promise.all([lockBackend.delete({ id: gone, confirm: true }), lockBackend.update({ id: keep, name: "Renamed while deleting" })]);
  const afterRace = await lockBackend.list({ refresh: false });
  assert.equal(afterRace.count, 5);
  assert.equal(afterRace.environments.some(e => e.id === gone), false, "deleted environment must not come back");
  const stale = await lockBackend._loadEnv(keep);
  await lockBackend.update({ id: keep, name: "Renamed during startup" });
  stale.runtime = { ...stale.runtime, status: "starting", marionettePort: 2999 };
  await lockBackend._saveRuntime(stale);
  const merged = await lockBackend._loadEnv(keep);
  assert.equal(merged.name, "Renamed during startup", "runtime save must not roll back a concurrent rename");
  assert.equal(merged.runtime.marionettePort, 2999);
  const ghostManifest = JSON.parse(await fs.readFile(path.join(lockRoot, "manifest.json"), "utf8"));
  ghostManifest.environments.push({ id: "ghost-env", name: "Ghost", runtime: { status: "stopped" } });
  await fs.writeFile(path.join(lockRoot, "manifest.json"), JSON.stringify(ghostManifest));
  assert.equal((await lockBackend.list({ refresh: false })).environments.some(e => e.id === "ghost-env"), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(lockRoot, "manifest.json"), "utf8")).environments.some(e => e.id === "ghost-env"), false, "ghost entries are pruned from the index");
  // 同一环境的更新与删除并发：更新要么在删除前完成，要么报 not found；删掉的环境不能被写回来。
  for (const victim of [many[2].environment.id, many[3].environment.id]) {
    const order = victim === many[2].environment.id
      ? [lockBackend.update({ id: victim, name: "Late write" }), lockBackend.delete({ id: victim, confirm: true })]
      : [lockBackend.delete({ id: victim, confirm: true }), lockBackend.update({ id: victim, name: "Late write" })];
    const settled = await Promise.allSettled(order);
    for (const result of settled.filter(r => r.status === "rejected")) {
      assert.match(String(result.reason?.message), /environment not found/);
    }
    await assert.rejects(fs.access(path.join(lockRoot, victim, "env.json")), "a deleted environment must not be resurrected");
    assert.equal((await lockBackend.list({ refresh: false })).environments.some(e => e.id === victim), false);
  }
  const lateRuntime = await lockBackend._loadEnv(many[4].environment.id);
  await lockBackend.delete({ id: lateRuntime.id, confirm: true });
  await assert.rejects(lockBackend._saveRuntime(lateRuntime), /environment not found/);
  await assert.rejects(fs.access(path.join(lockRoot, lateRuntime.id)), "a late runtime save must not recreate the directory");

  const spawned = [];
  const quitCalls = [];
  let quitWorks = true;
  let exitOnQuit = true;
  let exitOnKill = true;
  const makeProc = pid => {
    const proc = {
      pid,
      exitCode: null,
      stdout: { async readString() { return ""; } },
      kill(timeout) {
        proc.killed = true;
        proc.killTimeout = timeout;
        if (exitOnKill === true) {
          proc.exitCode = 0;
        } else if (typeof exitOnKill === "number") {
          setTimeout(() => {
            proc.exitCode = 0;
          }, exitOnKill); // 收到终止信号后过一会儿才退出
        }
      },
    };
    return proc;
  };
  const lifecycle = new EnvironmentBackend({
    root: path.join(root, "lifecycle"),
    firefoxBin: "/Applications/Firefox Reverse.app/Contents/MacOS/firefox",
    subprocess: {
      async pathSearch(name) {
        return `/usr/bin/${name}`;
      },
      async call(spec) {
        const proc = makeProc(9000 + spawned.length);
        spawned.push({ spec, proc });
        return proc;
      },
    },
    portProbe: async () => true,
    portReadyProbe: async port => spawned.some(s => s.spec.environment?.MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS?.includes(String(port))),
    marionetteQuit: async (port, options = {}) => {
      quitCalls.push({ port, profileSuffix: options.profileSuffix });
      if (quitWorks && exitOnQuit) {
        for (const s of spawned) {
          if (s.spec.environment?.MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS?.includes(String(port))) {
            s.proc.exitCode = 0;
          }
        }
      }
      return quitWorks;
    },
    startupTimeoutMs: 200,
    startupPollMs: 1,
    closeWaitMs: 50,
    controlAckMs: 200,
  });
  const envA = (await lifecycle.create({ name: "Lifecycle A" })).environment;
  const envB = (await lifecycle.create({ name: "Lifecycle B" })).environment;
  const [openA, openB] = await Promise.all([lifecycle.open({ id: envA.id }), lifecycle.open({ id: envB.id })]);
  assert.notEqual(openA.environment.runtime.marionettePort, openB.environment.runtime.marionettePort, "concurrent opens must not share a Marionette port");
  const launchesBefore = spawned.length;
  const [againA, againA2] = await Promise.all([lifecycle.open({ id: envA.id }), lifecycle.open({ id: envA.id })]);
  assert.equal(spawned.length, launchesBefore, "an already running environment is never launched twice");
  assert.ok(againA.alreadyRunning && againA2.alreadyRunning);

  const closedA = await lifecycle.close({ id: envA.id });
  assert.equal(closedA.ok, true);
  assert.equal(closedA.environment.runtime.stopReason, "closed", "graceful Marionette quit comes first");
  assert.deepEqual(quitCalls.at(-1), { port: openA.environment.runtime.marionettePort, profileSuffix: `/${envA.id}/profile` }, "the quit only accepts this environment's own session");
  assert.equal(spawned.find(s => s.proc.pid === openA.environment.runtime.pid).proc.killed, undefined);

  quitWorks = false;
  const closedB = await lifecycle.close({ id: envB.id });
  assert.equal(closedB.environment.runtime.stopReason, "terminated");
  assert.equal(spawned.find(s => s.proc.pid === openB.environment.runtime.pid).proc.killed, true, "falls back to terminating the process");

  exitOnKill = false;
  const reopenedB = await lifecycle.open({ id: envB.id });
  const stubborn = await lifecycle.close({ id: envB.id });
  assert.equal(stubborn.ok, false);
  assert.equal(stubborn.environment.runtime.status, "running", "a process that did not exit must not be recorded as stopped");
  assert.equal(stubborn.environment.runtime.pid, reopenedB.environment.runtime.pid);
  exitOnKill = true;

  // ── 环境内退出通道（EnvironmentControl）：先于 Marionette；没在听、标记过期或 pid 对不上时退回 Marionette ──
  const controlOf = envId => path.join(root, "lifecycle", envId, "control");
  const requestOf = envId => path.join(controlOf(envId), "quit-request.json");
  const markReady = (envId, pid, startedAt = Date.now()) =>
    fs.writeFile(path.join(controlOf(envId), "quit-channel.json"), JSON.stringify({ version: 1, envId, pid, startedAt }));
  // 模拟环境浏览器：看到发给自己的请求就取走，过 exitDelay 毫秒后退出
  const listen = (envId, pid, proc, exitDelay = 0) => {
    const timer = setInterval(async () => {
      let req = null;
      try {
        req = JSON.parse(await fs.readFile(requestOf(envId), "utf8"));
      } catch {
        return;
      }
      if (req.envId !== envId || req.pid !== pid) {
        return;
      }
      clearInterval(timer);
      await fs.rm(requestOf(envId), { force: true });
      setTimeout(() => {
        proc.exitCode = 0;
      }, exitDelay);
    }, 5);
    return () => clearInterval(timer);
  };
  const procOf = opened => spawned.find(s => s.proc.pid === opened.environment.runtime.pid).proc;
  const envC = (await lifecycle.create({ name: "Lifecycle C" })).environment;
  quitWorks = true;
  let openC = await lifecycle.open({ id: envC.id });
  await markReady(envC.id, openC.environment.runtime.pid);
  let stopListening = listen(envC.id, openC.environment.runtime.pid, procOf(openC), 30);
  const quitsBeforeChannel = quitCalls.length;
  const viaChannel = await lifecycle.close({ id: envC.id });
  stopListening();
  assert.equal(viaChannel.environment.runtime.stopReason, "closed");
  assert.equal(viaChannel.environment.runtime.closedBy, "quit-channel", "the in-environment quit channel comes before Marionette");
  assert.equal(quitCalls.length, quitsBeforeChannel, "Marionette is not touched when the channel answers");
  assert.equal(procOf(openC).killed, undefined);

  openC = await lifecycle.open({ id: envC.id });
  assert.equal(openC.environment.runtime.closedBy, null, "a reopened environment does not carry the previous close method");
  await markReady(envC.id, openC.environment.runtime.pid);
  const deaf = await lifecycle.close({ id: envC.id });
  assert.equal(deaf.environment.runtime.closedBy, "marionette", "an unanswered request falls back to Marionette");
  assert.equal(quitCalls.length, quitsBeforeChannel + 1);
  await assert.rejects(fs.access(requestOf(envC.id)), "an unanswered request is withdrawn");

  for (const marker of [{ pidDelta: 0, age: 60000 }, { pidDelta: 0, beforeLaunch: 1000 }, { pidDelta: 1, age: 0 }]) {
    openC = await lifecycle.open({ id: envC.id });
    const startedAt = marker.beforeLaunch ? Date.parse(openC.environment.runtime.lastStartedAt) - marker.beforeLaunch : Date.now() - marker.age;
    await markReady(envC.id, openC.environment.runtime.pid + marker.pidDelta, startedAt);
    stopListening = listen(envC.id, openC.environment.runtime.pid, procOf(openC));
    const skipped = await lifecycle.close({ id: envC.id });
    stopListening();
    assert.equal(skipped.environment.runtime.closedBy, "marionette", "no request for a stale or foreign marker: " + JSON.stringify(marker));
    await assert.rejects(fs.access(requestOf(envC.id)));
  }

  // 写退出请求失败（磁盘满、没有权限）：不报错、不卡在"关闭中"，照常退回 Marionette
  openC = await lifecycle.open({ id: envC.id });
  await markReady(envC.id, openC.environment.runtime.pid);
  const writeJSON = IOUtils.writeJSON;
  IOUtils.writeJSON = async (p, data) => {
    if (p.endsWith("quit-request.json")) {
      throw new Error("NotAllowedError: cannot write");
    }
    return writeJSON(p, data);
  };
  const unwritable = await lifecycle.close({ id: envC.id });
  IOUtils.writeJSON = writeJSON;
  assert.equal(unwritable.ok, true);
  assert.equal(unwritable.environment.runtime.closedBy, "marionette", "a failed request write falls back to Marionette");

  // 等环境取走请求的这段时间里，进程自己退出了：如实记为 exited，未被取走的请求撤回
  openC = await lifecycle.open({ id: envC.id });
  await markReady(envC.id, openC.environment.runtime.pid);
  setTimeout(() => {
    procOf(openC).exitCode = 0;
  }, 50);
  const selfExit = await lifecycle.close({ id: envC.id });
  assert.equal(selfExit.environment.runtime.closedBy, "exited");
  await assert.rejects(fs.access(requestOf(envC.id)), "the unanswered request is withdrawn");

  // 终止信号之后进程退得慢，刚好在等待截止之后才退出、强杀命令因 pid 已不在而失败：仍要认出它已经退出。
  // Subprocess 自己补发 SIGKILL 的时间要晚于后端的等待。
  const envD = (await lifecycle.create({ name: "Lifecycle D" })).environment;
  const openD = await lifecycle.open({ id: envD.id });
  quitWorks = false;
  exitOnKill = 350;
  const late = await lifecycle.close({ id: envD.id });
  exitOnKill = true;
  quitWorks = true;
  assert.equal(late.ok, true, "a process that exits right after the deadline is recognised as gone");
  assert.equal(late.environment.runtime.stopReason, "terminated");
  assert.equal(late.environment.runtime.closedBy, "signal");
  assert.equal(procOf(openD).killTimeout, 50 + 5000, "Subprocess's own SIGKILL comes after the backend's wait");

  // 上一个浏览器会话打开的环境（没有进程句柄，靠命令行核对身份）：同样先走通道，一个信号都不发
  openC = await lifecycle.open({ id: envC.id });
  const pidC = openC.environment.runtime.pid;
  await markReady(envC.id, pidC);
  let aliveC = true;
  const detachedSignals = [];
  const detached = new EnvironmentBackend({
    root: path.join(root, "lifecycle"),
    subprocess: {
      async pathSearch(name) {
        return `/usr/bin/${name}`;
      },
      async call(spec) {
        if (spec.command.endsWith("/kill")) {
          detachedSignals.push(spec.arguments);
        }
        const isPs = spec.command.endsWith("/ps");
        const output = isPs && aliveC ? `firefox -marionette -profile ${openC.environment.profilePath}\n` : "";
        let read = false;
        return {
          stdout: { async readString() { if (read) return ""; read = true; return output; } },
          async wait() { return { exitCode: isPs && !aliveC ? 1 : 0 }; },
        };
      },
    },
    marionetteQuit: async () => false,
    closeWaitMs: 2000,
    controlAckMs: 500,
  });
  stopListening = listen(envC.id, pidC, { set exitCode(_value) { aliveC = false; } });
  const detachedClose = await detached.close({ id: envC.id });
  stopListening();
  assert.equal(detachedClose.ok, true);
  assert.equal(detachedClose.environment.runtime.closedBy, "quit-channel");
  assert.equal(detachedSignals.length, 0, "no signal is sent when the channel answers");
  procOf(openC).exitCode = 0;

  // 上一个浏览器会话留下的记录（没有进程句柄）：pid 已被别的程序复用时不发任何信号
  const commands = [];
  const reused = new EnvironmentBackend({
    root: path.join(root, "lifecycle"),
    subprocess: {
      async pathSearch(name) {
        return `/usr/bin/${name}`;
      },
      async call(spec) {
        commands.push(spec);
        const output = spec.command.endsWith("/ps") ? "/usr/lib/other-app --flag\n" : "";
        let read = false;
        return {
          stdout: { async readString() { if (read) return ""; read = true; return output; } },
          async wait() { return { exitCode: 0 }; },
        };
      },
    },
    marionetteQuit: async () => false,
  });
  const reusedEnv = await reused._loadEnv(envB.id);
  assert.equal(await reused._pidState(reusedEnv.runtime.pid, reusedEnv.id, reusedEnv), "dead", "a pid running another program is not this environment");
  const reusedClose = await reused.close({ id: envB.id });
  assert.equal(reusedClose.ok, true);
  assert.equal(reusedClose.environment.runtime.stopReason, "process-not-found");
  assert.equal(commands.some(spec => spec.command.endsWith("/kill")), false, "no signal is sent to a reused pid");
  const ownCommand = `firefox -marionette -profile ${reusedEnv.profilePath}\n`;
  const matches = new EnvironmentBackend({
    root: path.join(root, "lifecycle"),
    subprocess: {
      async pathSearch(name) {
        return `/usr/bin/${name}`;
      },
      async call() {
        let read = false;
        return { stdout: { async readString() { if (read) return ""; read = true; return ownCommand; } }, async wait() { return { exitCode: 0 }; } };
      },
    },
  });
  assert.equal(await matches._pidState(4242, reusedEnv.id, reusedEnv), "alive", "the environment's own profile on the command line proves identity");

  await backend.delete({ id, confirm: true });
  await backend.delete({ id: importedEnv.id, confirm: true });
  const afterDelete = await backend.list({ refresh: false });
  assert.equal(afterDelete.count, 0);

  console.log("EnvironmentBackend selftest ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
