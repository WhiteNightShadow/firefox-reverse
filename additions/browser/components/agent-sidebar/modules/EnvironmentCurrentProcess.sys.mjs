/* EnvironmentCurrentProcess.sys.mjs — 主浏览器（当前进程）自己的指纹和代理配置。配置存在环境根目录的
 * .current-process 下，通过改写当前 profile 的 user.js 托管块生效，C++ 在下次启动时读取。 */

import { NATIVE_CONSISTENCY_MODE, isNativeFingerprint } from "./NativeFingerprintPolicy.sys.mjs";
import {
  SCHEMA_VERSION,
  currentEnvId,
  currentMarionettePort,
  nowISO,
  randHex,
  safe,
  timestampId,
  unwrapField,
} from "./EnvironmentCommon.sys.mjs";
import { buildFingerprint, fingerprintFromCapture, firefoxGenerateOptions, validateFingerprint } from "./EnvironmentFingerprint.sys.mjs";
import { defaultProxy, fingerprintUserPrefs, mergeManagedUserJs, proxyUserPrefs, stripManagedUserJs } from "./EnvironmentPrefs.sys.mjs";

const CURRENT_PROCESS_DIR_NAME = ".current-process";
export const CURRENT_PROCESS_ID = "current-process";

export class CurrentProcessConfig {
  constructor(store) {
    this._store = store;
  }

  profilePath() {
    return safe(() => Services.dirsvc.get("ProfD", Ci.nsIFile).path, "");
  }

  paths() {
    const rootPath = PathUtils.join(this._store.root, CURRENT_PROCESS_DIR_NAME);
    const profilePath = this.profilePath();
    const profileFrxDir = profilePath ? PathUtils.join(profilePath, "frx") : "";
    return {
      rootPath,
      metaPath: PathUtils.join(rootPath, "meta.json"),
      fingerprintPath: PathUtils.join(rootPath, "fingerprint.json"),
      proxyPath: PathUtils.join(rootPath, "proxy.json"),
      traceDir: PathUtils.join(rootPath, "traces"),
      controlDir: PathUtils.join(rootPath, "control"),
      capturesDir: PathUtils.join(rootPath, "captures"),
      logsDir: PathUtils.join(rootPath, "logs"),
      profilePath,
      profileFrxDir,
      runtimeFingerprintPath: profileFrxDir ? PathUtils.join(profileFrxDir, "fingerprint.json") : "",
      runtimeProxyPath: profileFrxDir ? PathUtils.join(profileFrxDir, "proxy.json") : "",
      profileUserJsPath: profilePath ? PathUtils.join(profilePath, "user.js") : "",
    };
  }

  async env() {
    await this._store.ensureRoot();
    const p = this.paths();
    if (!p.profilePath) {
      throw new Error("cannot locate current Firefox profile");
    }
    for (const dir of [p.rootPath, p.profileFrxDir, p.traceDir, p.controlDir, p.capturesDir, p.logsDir]) {
      if (!dir) {
        continue;
      }
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    let meta = await this._store.readJSON(p.metaPath, null);
    if (!meta || typeof meta !== "object") {
      meta = {
        schemaVersion: SCHEMA_VERSION,
        id: CURRENT_PROCESS_ID,
        name: "当前主进程",
        createdAt: nowISO(),
        seed: randHex(16),
        seedMode: "persistent",
      };
      await this._store.writeJSON(p.metaPath, meta);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      id: CURRENT_PROCESS_ID,
      name: "当前主进程",
      browserFamily: "firefox",
      createdAt: meta.createdAt || nowISO(),
      updatedAt: meta.updatedAt || meta.createdAt || nowISO(),
      rootPath: p.rootPath,
      profilePath: p.profilePath,
      fingerprintPath: p.fingerprintPath,
      proxyPath: p.proxyPath,
      traceDir: p.traceDir,
      controlDir: p.controlDir,
      capturesDir: p.capturesDir,
      logsDir: p.logsDir,
      seed: meta.seed || randHex(16),
      seedMode: meta.seedMode || "persistent",
      source: meta.source || { type: "current-process" },
      runtime: {
        status: "current",
        pid: safe(() => Services.appinfo.processID, null),
        marionettePort: currentMarionettePort(),
        processLabel: "Firefox Reverse 主进程",
      },
    };
  }

  defaultFingerprint(env) {
    return buildFingerprint(env, { enabled: false, consistencyMode: NATIVE_CONSISTENCY_MODE }, { type: "current-process-default" });
  }

  async readOrCreate(type = "fingerprint") {
    const env = await this.env();
    const p = this.paths();
    const t = String(type || "fingerprint").toLowerCase();
    const path = t === "proxy" ? p.proxyPath : p.fingerprintPath;
    let config = await this._store.readJSON(path, null);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = t === "proxy" ? defaultProxy() : this.defaultFingerprint(env);
      await this._store.writeJSON(path, config);
    }
    return { env, paths: p, type: t, path, config };
  }

  async upsertProfileUserJs(fingerprint, proxy) {
    validateFingerprint(fingerprint);
    const env = await this.env();
    const p = this.paths();
    if (!p.profileUserJsPath) {
      throw new Error("cannot locate current profile user.js");
    }
    await IOUtils.makeDirectory(p.profilePath, { ignoreExisting: true, createAncestors: true });
    const nativeRenderingManaged = isNativeFingerprint(fingerprint) || safe(() => Services.prefs.getBoolPref("frx.fingerprint.native_rendering_managed", false), false);
    const prefLines = [
      `user_pref("frx.fingerprint.native_rendering_managed", ${nativeRenderingManaged});`,
      `user_pref("frx.fingerprint.config.path", ${JSON.stringify(p.runtimeFingerprintPath || p.fingerprintPath)});`,
      `user_pref("frx.fingerprint.config.json", ${JSON.stringify(isNativeFingerprint(fingerprint) ? "" : JSON.stringify(fingerprint || {}))});`,
      `user_pref("frx.proxy.config.path", ${JSON.stringify(p.runtimeProxyPath || p.proxyPath)});`,
      `user_pref("frx.current_process.fingerprint.enabled", true);`,
      ...fingerprintUserPrefs(fingerprint || {}, nativeRenderingManaged),
      // 主浏览器只在明确启用代理时才写代理 pref；否则保留用户自己的代理设置（Firefox 默认跟随系统），
      // 不能因为只改了时区就把主浏览器改成直连。
      ...(proxy && proxy.enabled === true ? proxyUserPrefs(proxy, fingerprint || {}) : []),
    ];
    let oldText = "";
    try {
      oldText = await IOUtils.readUTF8(p.profileUserJsPath);
    } catch {
      oldText = "";
    }
    // 上一版托管块写过、这一版不再写的 pref 要清掉运行值，见 mergeManagedUserJs。
    const { text: next, dropped } = mergeManagedUserJs(oldText, prefLines);
    await IOUtils.writeUTF8(p.profileUserJsPath, next, { tmpPath: p.profileUserJsPath + ".tmp" });
    for (const name of dropped) {
      try {
        if (Services.prefs.prefHasUserValue(name)) {
          Services.prefs.clearUserPref(name);
        }
      } catch {
        /* best effort */
      }
    }
    if (p.runtimeFingerprintPath) {
      await this._store.writeJSON(p.runtimeFingerprintPath, fingerprint || {});
    }
    if (p.runtimeProxyPath) {
      await this._store.writeJSON(p.runtimeProxyPath, proxy || {});
    }
    try {
      Services.prefs.setStringPref("frx.fingerprint.config.path", p.runtimeFingerprintPath || p.fingerprintPath);
      Services.prefs.setStringPref("frx.fingerprint.config.json", isNativeFingerprint(fingerprint) ? "" : JSON.stringify(fingerprint || {}));
      Services.prefs.setStringPref("frx.proxy.config.path", p.runtimeProxyPath || p.proxyPath);
      Services.prefs.setBoolPref("frx.current_process.fingerprint.enabled", true);
    } catch {
      /* runtime pref update is best-effort; C++ fingerprint config is startup-cached */
    }
    env.updatedAt = nowISO();
    await this._store.writeJSON(p.metaPath, {
      schemaVersion: SCHEMA_VERSION,
      id: CURRENT_PROCESS_ID,
      name: "当前主进程",
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      seed: env.seed,
      seedMode: env.seedMode,
      source: { type: "current-process", updatedAt: env.updatedAt },
    });
  }

  async removeProfileUserJsBlock() {
    const p = this.paths();
    if (!p.profileUserJsPath) {
      throw new Error("cannot locate current profile user.js");
    }
    let oldText = "";
    try {
      oldText = await IOUtils.readUTF8(p.profileUserJsPath);
    } catch {
      oldText = "";
    }
    const { text: next, names: namesToClear } = stripManagedUserJs(oldText, [
      "frx.fingerprint.config.path",
      "frx.fingerprint.config.json",
      "frx.proxy.config.path",
      "frx.current_process.fingerprint.enabled",
    ]);
    await IOUtils.writeUTF8(p.profileUserJsPath, next, {
      tmpPath: p.profileUserJsPath + ".tmp",
    });
    for (const name of namesToClear) {
      try {
        if (Services.prefs.prefHasUserValue(name)) {
          Services.prefs.clearUserPref(name);
        }
      } catch {
        /* best effort */
      }
    }
  }

  // 主浏览器本身是受管环境时，managed(id, refresh) 返回该环境的摘要（由环境后端提供）。
  async describe({ refresh = true } = {}, managed) {
    const env = await this.env();
    const p = this.paths();
    const envId = currentEnvId();
    let managedEnvironment = null;
    let managedError = "";
    if (envId) {
      try {
        managedEnvironment = await managed(envId, refresh);
      } catch (e) {
        managedError = e && e.message ? e.message : String(e);
      }
    }
    const envConfigPath = safe(() => Services.env.get("MOZ_FRX_FINGERPRINT_CONFIG"), "");
    const envInline = safe(() => Services.env.get("MOZ_FRX_FINGERPRINT_JSON"), "");
    const prefConfigPath = safe(() => Services.prefs.getStringPref("frx.fingerprint.config.path", ""), "");
    const proxyPrefPath = safe(() => Services.prefs.getStringPref("frx.proxy.config.path", ""), "");
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      name: "当前主进程",
      root: this._store.root,
      profilePath: p.profilePath,
      fingerprintPath: p.fingerprintPath,
      proxyPath: p.proxyPath,
      activeFingerprintPath: envConfigPath || prefConfigPath || "",
      activeProxyPath: safe(() => Services.env.get("MOZ_FRX_PROXY_CONFIG"), "") || proxyPrefPath || "",
      hasInlineFingerprint: !!envInline,
      managedEnvId: envId || null,
      managedEnvironment,
      managedError,
      editable: !envId,
      needsRestartOnWrite: true,
      runtime: env.runtime,
    };
  }

  async read({ type = "fingerprint" } = {}) {
    const res = await this.readOrCreate(type);
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      type: res.type,
      path: res.path,
      profilePath: res.paths.profilePath,
      config: res.config,
      needsRestart: true,
    };
  }

  async write({ type = "fingerprint", config, text } = {}) {
    const res = await this.readOrCreate(type);
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("config must be a JSON object");
    }
    data.schemaVersion = data.schemaVersion || SCHEMA_VERSION;
    if (res.type === "fingerprint") validateFingerprint(data);
    data.updatedAt = nowISO();
    await this._store.writeJSON(res.path, data);
    const fingerprint =
      res.type === "fingerprint"
        ? data
        : (await this.readOrCreate("fingerprint")).config;
    const proxy =
      res.type === "proxy"
        ? data
        : (await this.readOrCreate("proxy")).config;
    await this.upsertProfileUserJs(fingerprint, proxy);
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      type: res.type,
      path: res.path,
      profilePath: res.paths.profilePath,
      config: data,
      needsRestart: true,
      note: "当前主进程的 C++ 指纹配置按启动读取；保存后请重启 Firefox Reverse 主进程。",
    };
  }

  async generate({ options = {} } = {}) {
    const env = await this.env();
    const p = this.paths();
    const previous = (await this.readOrCreate("fingerprint")).config;
    env.consistencyMode = options.consistencyMode || (isNativeFingerprint(previous) ? NATIVE_CONSISTENCY_MODE : "legacy");
    env.audioSeed = unwrapField(previous.audio?.seed, "");
    const generationOptions = env.consistencyMode === NATIVE_CONSISTENCY_MODE ? firefoxGenerateOptions(options) : options;
    const fingerprint = buildFingerprint(env, generationOptions, { type: "generated", target: CURRENT_PROCESS_ID });
    validateFingerprint(fingerprint);
    await this._store.writeJSON(p.fingerprintPath, fingerprint);
    const proxy = (await this.readOrCreate("proxy")).config;
    await this.upsertProfileUserJs(fingerprint, proxy);
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      path: p.fingerprintPath,
      profilePath: p.profilePath,
      fingerprint,
      needsRestart: true,
    };
  }

  async latestCapturePath() {
    const p = this.paths();
    let children = [];
    try {
      children = await IOUtils.getChildren(p.capturesDir);
    } catch {
      return "";
    }
    const captures = (children || []).filter(x => String(x).endsWith(".json")).sort();
    return captures.length ? captures[captures.length - 1] : "";
  }

  async importCapture({ capturePath, capture, text } = {}) {
    const env = await this.env();
    const p = this.paths();
    const previous = (await this.readOrCreate("fingerprint")).config;
    env.consistencyMode = isNativeFingerprint(previous) ? NATIVE_CONSISTENCY_MODE : "legacy";
    env.audioSeed = unwrapField(previous.audio?.seed, "");
    let finalCapture = capture || null;
    if (!finalCapture && text != null) {
      finalCapture = JSON.parse(String(text));
      if (typeof finalCapture === "string") {
        finalCapture = JSON.parse(finalCapture);
      }
    }
    let finalPath = String(capturePath || "");
    if (!finalCapture) {
      if (!finalPath) {
        finalPath = await this.latestCapturePath();
      } else if (!finalPath.includes("/") && !finalPath.includes("\\")) {
        finalPath = PathUtils.join(p.capturesDir, finalPath);
      }
      if (!finalPath) {
        throw new Error("no capture found to import");
      }
      finalCapture = await this._store.readJSON(finalPath, null);
    }
    if (!finalCapture || typeof finalCapture !== "object") {
      throw new Error("capture must be a JSON object");
    }
    if (!finalPath) {
      await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
      finalPath = PathUtils.join(p.capturesDir, `capture_pasted_${timestampId()}_${randHex(3)}.json`);
      await this._store.writeJSON(finalPath, finalCapture);
    }
    const fingerprint = fingerprintFromCapture(env, finalCapture, {
      type: "imported-capture",
      path: finalPath || null,
    });
    await this._store.writeJSON(p.fingerprintPath, fingerprint);
    const proxy = (await this.readOrCreate("proxy")).config;
    await this.upsertProfileUserJs(fingerprint, proxy);
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      path: p.fingerprintPath,
      capturePath: finalPath || null,
      profilePath: p.profilePath,
      fingerprint,
      needsRestart: true,
    };
  }

  async reset({ confirm = false } = {}) {
    if (confirm !== true) {
      throw new Error("confirm:true required to reset current process fingerprint defaults");
    }
    await this._store.ensureRoot();
    const p = this.paths();
    await this.removeProfileUserJsBlock();
    for (const path of [p.fingerprintPath, p.proxyPath, p.metaPath]) {
      try {
        await IOUtils.remove(path, { ignoreAbsent: true });
      } catch {
        /* best effort */
      }
    }
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      reset: true,
      profilePath: p.profilePath,
      needsRestart: true,
      note: "已还原当前主进程默认配置；请重启 Firefox Reverse，让 C++ 指纹配置回退到原始行为。",
    };
  }
}
