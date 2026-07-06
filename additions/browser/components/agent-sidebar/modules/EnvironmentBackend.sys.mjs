/* EnvironmentBackend.sys.mjs
 *
 * Environment-level browser isolation:
 *   one environment = one profile directory + one Firefox process.
 *
 * Data lives outside any Firefox profile, under:
 *   ~/.firefox-reverse/environments
 *
 * This module creates the environment file protocol, stable profile prefs, and
 * launch surface consumed by the C++/Gecko fingerprint layer.
 */

const SCHEMA_VERSION = 1;
const DEFAULT_DIR_NAME = "environments";
const DEFAULT_PORT_BASE = 2828;
const MAX_PORT_SCAN = 200;
const ENV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CURRENT_PROCESS_DIR_NAME = ".current-process";
const CURRENT_PROCESS_ID = "current-process";
const USERJS_BLOCK_START = "// >>> Firefox Reverse current-process fingerprint prefs";
const USERJS_BLOCK_END = "// <<< Firefox Reverse current-process fingerprint prefs";
const AUTOMATION_STEALTH_PREFS = {
  "remote.prefs.recommended": false,
  "frx.hideRemoteControlCue": true,
  "browser.chrome.disableRemoteControlCueForTests": true,
  "browser.privatebrowsing.autostart": false,
  "browser.startup.couldRestoreSession.count": -1,
  "browser.sessionstore.resume_from_crash": false,
  "places.history.enabled": true,
  "dom.storage.enabled": true,
  "browser.cache.disk.enable": true,
  "browser.cache.memory.enable": true,
  "privacy.sanitize.sanitizeOnShutdown": false,
  "privacy.clearOnShutdown.history": false,
  "privacy.clearOnShutdown.formdata": false,
  "privacy.clearOnShutdown.downloads": false,
  "privacy.clearOnShutdown.cookies": false,
  "privacy.clearOnShutdown.cache": false,
  "privacy.clearOnShutdown.sessions": false,
  "privacy.clearOnShutdown_v2.historyFormDataAndDownloads": false,
  "privacy.clearOnShutdown_v2.browsingHistoryAndDownloads": false,
  "privacy.clearOnShutdown_v2.cookiesAndStorage": false,
  "privacy.clearOnShutdown_v2.cache": false,
  "dom.permissions.testing.enabled": false,
  "media.navigator.permission.disabled": false,
  "media.navigator.streams.fake": false,
};
// BrowserScan 这类站会用 CSS/JS/WebAPI 特性矩阵反推 Chromium 版本。
// 现阶段 Chrome-like 覆盖还没补到 153 的完整特性面，默认生成先收敛到本地实测更稳的兼容版本；
// 用户手动填写 chromeVersion 时不受这个 cap 限制。
const DEFAULT_CHROME_FEATURE_COMPAT_MAJOR = 150;

function nowISO() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function isRuntimeActive(runtime) {
  const status = String(runtime?.status || "").toLowerCase();
  return status === "running" || status === "starting" || status === "closing";
}

function lazyESM(url) {
  try {
    return ChromeUtils.importESModule(url);
  } catch {
    return null;
  }
}

function randHex(bytes = 8) {
  const a = new Uint8Array(bytes);
  try {
    globalThis.crypto.getRandomValues(a);
  } catch {
    for (let i = 0; i < a.length; i++) {
      a[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

function field(value, enabled = true) {
  return { enabled, value };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function parseResolution(v, fallback = { width: 1920, height: 1080 }) {
  if (v && typeof v === "object") {
    return {
      width: clampInt(v.width, 320, 10000, fallback.width),
      height: clampInt(v.height, 240, 10000, fallback.height),
    };
  }
  const m = String(v || "").match(/(\d{3,5})\s*[x*]\s*(\d{3,5})/i);
  if (!m) {
    return fallback;
  }
  return {
    width: clampInt(m[1], 320, 10000, fallback.width),
    height: clampInt(m[2], 240, 10000, fallback.height),
  };
}

function normalizeVersion(v, fallback = "128.0") {
  const raw = String(v || "").trim();
  const m = raw.match(/\d+(?:\.\d+){0,2}/);
  return m ? m[0] : fallback;
}

function normalizeLanguages(language, languages) {
  const primary = String(language || "").trim() || "en-US";
  if (Array.isArray(languages) && languages.length) {
    const out = languages.map(x => String(x || "").trim()).filter(Boolean);
    if (out.length) {
      return out[0] === primary ? out : [primary, ...out.filter(x => x !== primary)];
    }
  }
  const base = primary.split("-")[0];
  const out = [primary];
  if (base && base !== primary) {
    out.push(base);
  }
  if (!out.includes("en-US") && base !== "en") {
    out.push("en-US", "en");
  }
  return [...new Set(out)];
}

function acceptLanguageFrom(languages) {
  return (languages || [])
    .map((lang, i) => {
      if (i === 0) {
        return lang;
      }
      const q = Math.max(0.1, 1 - i * 0.1).toFixed(1);
      return `${lang};q=${q}`;
    })
    .join(",");
}

function browserFamilyFromUA(userAgent) {
  const ua = String(userAgent || "");
  if (/Firefox\//i.test(ua)) {
    return "firefox";
  }
  if (/(Edg|OPR|Chrome|Chromium)\//i.test(ua)) {
    return "chromium";
  }
  if (/Safari\//i.test(ua)) {
    return "safari";
  }
  return "unknown";
}

function chromeVersionFromUA(userAgent, fallback = "128.0.0.0") {
  const ua = String(userAgent || "");
  const m = ua.match(/(?:Chrome|Chromium|Edg|OPR)\/([0-9.]+)/i);
  return m ? chromeFullVersion(m[1], majorVersion(fallback, 128)) : fallback;
}

function normalizeBrowserFamily(value, fallback = "firefox") {
  const v = String(value || "").trim().toLowerCase();
  if (v === "chrome" || v === "chromium" || v === "blink" || v === "chrome-like" || v === "chromelike") {
    return "chromium";
  }
  if (v === "firefox" || v === "gecko") {
    return "firefox";
  }
  return fallback;
}

function osFromUA(userAgent, fallback = "windows") {
  const ua = String(userAgent || "");
  if (/Windows NT/i.test(ua)) {
    return "windows";
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return "macos";
  }
  if (/Linux|X11/i.test(ua)) {
    return "linux";
  }
  return fallback;
}

function majorVersion(value, fallback = 128) {
  return clampInt(String(value || "").split(".")[0], 1, 999, fallback);
}

function chromeFullVersion(value, fallbackMajor = 128) {
  const text = String(value || "").trim();
  const parts = text.split(".").filter(Boolean);
  const major = majorVersion(parts[0] || text, fallbackMajor);
  if (parts.length >= 4) {
    return [major, ...parts.slice(1, 4).map(x => clampInt(x, 0, 999999, 0))].join(".");
  }
  return `${major}.0.0.0`;
}

function chromeBrands(major, fullVersion = `${major}.0.0.0`) {
  const m = String(major);
  return {
    brands: [
      { brand: "Chromium", version: m },
      { brand: "Google Chrome", version: m },
      { brand: "Not A(Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: fullVersion },
      { brand: "Google Chrome", version: fullVersion },
      { brand: "Not A(Brand", version: "24.0.0.0" },
    ],
  };
}

function secChUaFromBrands(brands = []) {
  return brands
    .filter(x => x && x.brand && x.version)
    .map(x => `"${String(x.brand).replaceAll('"', '\\"')}";v="${String(x.version).replaceAll('"', '\\"')}"`)
    .join(", ");
}

function unwrapField(v, fallback = null) {
  if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
    return v.value;
  }
  return v == null ? fallback : v;
}

function configField(parent, key, fallback = null) {
  if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) {
    return fallback;
  }
  const v = parent[key];
  if (v && typeof v === "object" && v.enabled === false) {
    return fallback;
  }
  return unwrapField(v, fallback);
}

function configBool(parent, key, fallback = false) {
  const v = configField(parent, key, fallback);
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") {
      return true;
    }
    if (s === "false" || s === "0" || s === "no") {
      return false;
    }
  }
  return Boolean(v);
}

function configInt(parent, key, min, max, fallback) {
  return clampInt(configField(parent, key, fallback), min, max, fallback);
}

function configNumber(parent, key, min, max, fallback) {
  return clampNumber(configField(parent, key, fallback), min, max, fallback);
}

function configString(parent, key, fallback = "") {
  const v = configField(parent, key, fallback);
  return v == null ? fallback : String(v);
}

function configArray(parent, key, fallback = []) {
  const v = configField(parent, key, fallback);
  return Array.isArray(v) ? v : fallback;
}

function configJSON(parent, key, fallback = null) {
  const v = configField(parent, key, fallback);
  if (v == null) {
    return fallback;
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return fallback;
  }
}

function hashString32(s) {
  let h = 2166136261;
  const text = String(s || "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pushUserPref(lines, name, value) {
  if (value == null) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return;
    }
    lines.push(`user_pref(${JSON.stringify(name)}, ${Number.isInteger(value) ? value : JSON.stringify(String(value))});`);
    return;
  }
  if (typeof value === "boolean") {
    lines.push(`user_pref(${JSON.stringify(name)}, ${value ? "true" : "false"});`);
    return;
  }
  lines.push(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(String(value))});`);
}

function pushUserPrefs(lines, prefs) {
  for (const [name, value] of Object.entries(prefs || {})) {
    pushUserPref(lines, name, value);
  }
}

function userPrefNames(lines) {
  const out = new Set();
  for (const line of lines || []) {
    const m = String(line).match(/user_pref\("([^"]+)"/);
    if (m) {
      out.add(m[1]);
    }
  }
  return out;
}

function proxyTypeOf(proxy) {
  const def = proxy && typeof proxy.default === "object" ? proxy.default : {};
  return String(def.type || proxy?.type || "direct").toLowerCase();
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function pick(items, fallback = null) {
  if (!Array.isArray(items) || !items.length) {
    return fallback;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function shortEnv(env) {
  return {
    id: env.id,
    name: env.name,
    processLabel: env.processLabel || env.runtime?.processLabel || processLabelFor(env),
    rootPath: env.rootPath,
    profilePath: env.profilePath,
    fingerprintPath: env.fingerprintPath,
    proxyPath: env.proxyPath,
    traceDir: env.traceDir,
    controlDir: env.controlDir,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
    source: env.source || null,
    runtime: env.runtime || { status: "stopped", pid: null },
  };
}

function envDisplayName(env) {
  return String(env?.name || env?.id || "Firefox Reverse Environment").trim();
}

function processLabelFor(env) {
  return envDisplayName(env);
}

function processSlotLabel(port) {
  const n = Number(port);
  if (Number.isFinite(n) && n >= DEFAULT_PORT_BASE && n < DEFAULT_PORT_BASE + MAX_PORT_SCAN) {
    return `Firefox Reverse ${n - DEFAULT_PORT_BASE + 1}`;
  }
  return "Firefox Reverse";
}

export class EnvironmentBackend {
  constructor(opts = {}) {
    this._root = opts.root || this._defaultRoot();
    this._firefoxBin = opts.firefoxBin || "";
    this._procs = new Map();
  }

  get root() {
    return this._root;
  }

  _hasIO() {
    return typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined";
  }

  _assertIO() {
    if (!this._hasIO()) {
      throw new Error("EnvironmentBackend requires Firefox IOUtils/PathUtils");
    }
  }

  _defaultRoot() {
    const envRoot = safe(() => Services.env.get("MOZ_FRX_ENVS_ROOT"), "") || safe(() => Services.env.get("FRX_ENVS_ROOT"), "");
    if (envRoot) {
      return envRoot;
    }
    const home =
      safe(() => Services.env.get("HOME"), "") ||
      safe(() => Services.env.get("USERPROFILE"), "") ||
      safe(() => PathUtils.homeDir, "");
    if (!home) {
      return "";
    }
    return PathUtils.join(home, ".firefox-reverse", DEFAULT_DIR_NAME);
  }

  _currentEnvId() {
    return (
      safe(() => Services.env.get("MOZ_FRX_ENV_ID"), "") ||
      safe(() => Services.env.get("FRX_ENV_ID"), "") ||
      safe(() => Services.prefs.getStringPref("frx.environment.id", ""), "")
    ).trim();
  }

  _paths(id) {
    const rootPath = PathUtils.join(this._root, id);
    const profilePath = PathUtils.join(rootPath, "profile");
    const profileFrxDir = PathUtils.join(profilePath, "frx");
    const traceDir = PathUtils.join(rootPath, "traces");
    const controlDir = PathUtils.join(rootPath, "control");
    return {
      rootPath,
      envPath: PathUtils.join(rootPath, "env.json"),
      fingerprintPath: PathUtils.join(rootPath, "fingerprint.json"),
      proxyPath: PathUtils.join(rootPath, "proxy.json"),
      profilePath,
      profileFrxDir,
      runtimeFingerprintPath: PathUtils.join(profileFrxDir, "fingerprint.json"),
      runtimeProxyPath: PathUtils.join(profileFrxDir, "proxy.json"),
      profileUserJsPath: PathUtils.join(profilePath, "user.js"),
      traceDir,
      controlDir,
      capturesDir: PathUtils.join(rootPath, "captures"),
      logsDir: PathUtils.join(rootPath, "logs"),
      runtimePath: PathUtils.join(controlDir, "runtime.json"),
    };
  }

  _currentProfilePath() {
    return safe(() => Services.dirsvc.get("ProfD", Ci.nsIFile).path, "");
  }

  _currentProcessPaths() {
    const rootPath = PathUtils.join(this._root, CURRENT_PROCESS_DIR_NAME);
    const profilePath = this._currentProfilePath();
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

  async _currentProcessEnv() {
    await this._ensureRoot();
    const p = this._currentProcessPaths();
    if (!p.profilePath) {
      throw new Error("cannot locate current Firefox profile");
    }
    for (const dir of [p.rootPath, p.profileFrxDir, p.traceDir, p.controlDir, p.capturesDir, p.logsDir]) {
      if (!dir) {
        continue;
      }
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    let meta = await this._readJSON(p.metaPath, null);
    if (!meta || typeof meta !== "object") {
      meta = {
        schemaVersion: SCHEMA_VERSION,
        id: CURRENT_PROCESS_ID,
        name: "当前主进程",
        createdAt: nowISO(),
        seed: randHex(16),
        seedMode: "persistent",
      };
      await this._writeJSON(p.metaPath, meta);
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
        marionettePort: this._currentMarionettePort(),
        processLabel: "Firefox Reverse 主进程",
      },
    };
  }

  _manifestPath() {
    return PathUtils.join(this._root, "manifest.json");
  }

  async _ensureRoot() {
    this._assertIO();
    if (!this._root) {
      throw new Error("environment root is empty");
    }
    await IOUtils.makeDirectory(this._root, { ignoreExisting: true, createAncestors: true });
    const manifestPath = this._manifestPath();
    if (!(await IOUtils.exists(manifestPath))) {
      await this._writeJSON(manifestPath, {
        schemaVersion: SCHEMA_VERSION,
        root: this._root,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        environments: [],
      });
    }
  }

  async _readJSON(path, fallback = null) {
    try {
      return await IOUtils.readJSON(path);
    } catch {
      return fallback;
    }
  }

  async _writeJSON(path, data) {
    const dir = PathUtils.parent(path);
    if (dir) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    await IOUtils.writeJSON(path, data, { tmpPath: path + ".tmp" });
  }

  async _loadManifest() {
    await this._ensureRoot();
    const m = await this._readJSON(this._manifestPath(), null);
    if (!m || !Array.isArray(m.environments)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        root: this._root,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        environments: [],
      };
    }
    return m;
  }

  async _saveManifest(manifest) {
    manifest.schemaVersion = SCHEMA_VERSION;
    manifest.root = this._root;
    manifest.updatedAt = nowISO();
    await this._writeJSON(this._manifestPath(), manifest);
  }

  async _saveEnv(env) {
    env.updatedAt = nowISO();
    await this._writeJSON(this._paths(env.id).envPath, env);
    await this._upsertManifest(env);
  }

  async _upsertManifest(env) {
    const manifest = await this._loadManifest();
    const summary = shortEnv(env);
    const i = manifest.environments.findIndex(e => e.id === env.id);
    if (i >= 0) {
      manifest.environments[i] = summary;
    } else {
      manifest.environments.push(summary);
    }
    manifest.environments.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    await this._saveManifest(manifest);
  }

  async _removeFromManifest(id) {
    const manifest = await this._loadManifest();
    manifest.environments = manifest.environments.filter(e => e.id !== id);
    await this._saveManifest(manifest);
  }

  _validateId(id) {
    if (!ENV_ID_RE.test(String(id || ""))) {
      throw new Error("invalid env id: use letters, numbers, _ or -");
    }
  }

  _newId(name) {
    const d = new Date();
    const stamp =
      d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") +
      "_" +
      String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0") +
      String(d.getSeconds()).padStart(2, "0");
    const slug = slugify(name);
    return "env_" + stamp + "_" + (slug ? slug + "_" : "") + randHex(4);
  }

  _detectDefaults() {
    const os = safe(() => Services.appinfo.OS, "");
    let platform = "linux";
    if (os === "WINNT") {
      platform = "windows";
    } else if (os === "Darwin") {
      platform = "macos";
    }
    const screenObj = safe(() => globalThis.screen, null);
    return {
      os: platform,
      firefoxVersion: normalizeVersion(safe(() => Services.appinfo.version, ""), "128.0"),
      language: safe(() => globalThis.navigator.language, "en-US") || "en-US",
      languages: safe(() => Array.from(globalThis.navigator.languages || []), null),
      resolution: {
        width: clampInt(safe(() => screenObj.width, 1920), 320, 10000, 1920),
        height: clampInt(safe(() => screenObj.height, 1080), 240, 10000, 1080),
      },
      timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC") || "UTC",
      devicePixelRatio: clampNumber(safe(() => globalThis.devicePixelRatio, 1), 0.5, 5, 1),
      hardwareConcurrency: clampInt(safe(() => globalThis.navigator.hardwareConcurrency, 8), 1, 128, 8),
    };
  }

  _uaParts(options = {}) {
    const os = String(options.os || "windows").toLowerCase();
    const browser = normalizeBrowserFamily(options.browser || options.browserFamily, "firefox");
    const appMajor = majorVersion(safe(() => Services.appinfo.version, ""), 128);
    const chromeVersion = chromeFullVersion(options.chromeVersion || options.chromiumVersion || options.version || appMajor, appMajor);
    const chromeMajor = majorVersion(chromeVersion, appMajor);
    const version = normalizeVersion(options.firefoxVersion || options.version || safe(() => Services.appinfo.version, ""), "128.0");
    if (browser === "chromium") {
      if (os === "mac" || os === "macos" || os === "darwin") {
        const platformComment = "Macintosh; Intel Mac OS X 10_15_7";
        return {
          browser: "chromium",
          os: "macos",
          platform: "MacIntel",
          uaPlatform: "macOS",
          chromeVersion,
          chromeMajor,
          userAgent: `Mozilla/5.0 (${platformComment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
        };
      }
      if (os === "linux") {
        const platformComment = "X11; Linux x86_64";
        return {
          browser: "chromium",
          os: "linux",
          platform: "Linux x86_64",
          uaPlatform: "Linux",
          chromeVersion,
          chromeMajor,
          userAgent: `Mozilla/5.0 (${platformComment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
        };
      }
      const platformComment = "Windows NT 10.0; Win64; x64";
      return {
        browser: "chromium",
        os: "windows",
        platform: "Win32",
        uaPlatform: "Windows",
        chromeVersion,
        chromeMajor,
        userAgent: `Mozilla/5.0 (${platformComment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
      };
    }
    if (os === "mac" || os === "macos" || os === "darwin") {
      return {
        browser: "firefox",
        os: "macos",
        platform: "MacIntel",
        uaPlatform: "macOS",
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
      };
    }
    if (os === "linux") {
      return {
        browser: "firefox",
        os: "linux",
        platform: "Linux x86_64",
        uaPlatform: "Linux",
        userAgent: `Mozilla/5.0 (X11; Linux x86_64; rv:${version}) Gecko/20100101 Firefox/${version}`,
      };
    }
    return {
      browser: "firefox",
      os: "windows",
      platform: "Win32",
      uaPlatform: "Windows",
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`,
    };
  }

  _webglDefaults(os, browser = "firefox") {
    if (browser === "chromium") {
      if (os === "macos") {
        return {
          vendor: "WebKit",
          renderer: "WebKit WebGL",
          unmaskedVendor: "Google Inc. (Apple)",
          unmaskedRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
        };
      }
      if (os === "linux") {
        return {
          vendor: "WebKit",
          renderer: "WebKit WebGL",
          unmaskedVendor: "Google Inc. (Intel)",
          unmaskedRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620, OpenGL 4.6)",
        };
      }
      return {
        vendor: "WebKit",
        renderer: "WebKit WebGL",
        unmaskedVendor: "Google Inc. (Intel)",
        unmaskedRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      };
    }
    if (os === "macos") {
      return {
        vendor: "Mozilla",
        renderer: "Mozilla",
        unmaskedVendor: "Apple Inc.",
        unmaskedRenderer: "Apple GPU",
      };
    }
    if (os === "linux") {
      return {
        vendor: "Mozilla",
        renderer: "Mozilla",
        unmaskedVendor: "Intel Inc.",
        unmaskedRenderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
      };
    }
    return {
      vendor: "Mozilla",
      renderer: "Mozilla",
      unmaskedVendor: "Google Inc. (Intel)",
      unmaskedRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    };
  }

  _fontDefaults(os) {
    if (os === "macos") {
      return ["Arial", "Helvetica", "Times New Roman", "Courier New", "Menlo", "Apple Color Emoji"];
    }
    if (os === "linux") {
      return ["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Noto Color Emoji"];
    }
    return ["Arial", "Calibri", "Cambria", "Times New Roman", "Segoe UI", "Courier New", "Segoe UI Emoji"];
  }

  _randomGenerateOptions() {
    const os = pick(["windows", "windows", "windows", "macos", "macos", "linux"], "windows");
    const localePools = {
      windows: [
        { language: "en-US", timezone: "America/New_York" },
        { language: "en-US", timezone: "America/Los_Angeles" },
        { language: "zh-CN", timezone: "Asia/Shanghai" },
        { language: "ja-JP", timezone: "Asia/Tokyo" },
        { language: "de-DE", timezone: "Europe/Berlin" },
        { language: "fr-FR", timezone: "Europe/Paris" },
      ],
      macos: [
        { language: "en-US", timezone: "America/Los_Angeles" },
        { language: "en-US", timezone: "America/New_York" },
        { language: "zh-CN", timezone: "Asia/Shanghai" },
        { language: "ja-JP", timezone: "Asia/Tokyo" },
        { language: "en-GB", timezone: "Europe/London" },
      ],
      linux: [
        { language: "en-US", timezone: "America/New_York" },
        { language: "en-US", timezone: "America/Chicago" },
        { language: "de-DE", timezone: "Europe/Berlin" },
        { language: "fr-FR", timezone: "Europe/Paris" },
        { language: "zh-CN", timezone: "Asia/Shanghai" },
      ],
    };
    const screenPools = {
      windows: ["1366x768", "1440x900", "1536x864", "1600x900", "1920x1080", "2560x1440"],
      macos: ["1440x900", "1512x982", "1680x1050", "1728x1117", "1920x1080", "2560x1440"],
      linux: ["1366x768", "1440x900", "1600x900", "1920x1080", "2560x1440"],
    };
    const dprPools = {
      windows: [1, 1, 1, 1.25, 1.5],
      macos: [1, 2, 2],
      linux: [1, 1, 1.25],
    };
    const version = normalizeVersion(safe(() => Services.appinfo.version, ""), "128.0");
    const major = Math.min(
      clampInt(String(version).split(".")[0], 100, 999, 128),
      DEFAULT_CHROME_FEATURE_COMPAT_MAJOR
    );
    const locale = pick(localePools[os], localePools.windows[0]);
    return {
      browser: "chromium",
      os,
      chromeVersion: `${major}.0.0.0`,
      firefoxVersion: pick([String(major), `${major}.0`, `${Math.max(100, major - 1)}.0`], version),
      language: locale.language,
      resolution: pick(screenPools[os], "1920x1080"),
      timezone: locale.timezone,
      devicePixelRatio: pick(dprPools[os], 1),
      hardwareConcurrency: pick([4, 6, 8, 8, 12, 16], 8),
    };
  }

  _buildFingerprint(env, options = {}, source = { type: "generated" }) {
    const defaults = this._detectDefaults();
    const randomOptions = options && options.randomize ? this._randomGenerateOptions() : {};
    const merged = { ...defaults, ...randomOptions, ...options };
    const ua = this._uaParts(merged);
    const navigatorOptions = merged.navigator && typeof merged.navigator === "object" ? merged.navigator : {};
    const screenOptions = merged.screen && typeof merged.screen === "object" ? merged.screen : {};
    const windowOptions = merged.window && typeof merged.window === "object" ? merged.window : {};
    const intlOptions = merged.intl && typeof merged.intl === "object" ? merged.intl : {};
    const webglOptions = merged.webgl && typeof merged.webgl === "object" ? merged.webgl : {};
    const canvasOptions = merged.canvas && typeof merged.canvas === "object" ? merged.canvas : {};
    const audioOptions = merged.audio && typeof merged.audio === "object" ? merged.audio : {};
    const fontsOptions = merged.fonts && typeof merged.fonts === "object" ? merged.fonts : {};
    const httpOptions = merged.http && typeof merged.http === "object" ? merged.http : {};
    const webrtcOptions = merged.webrtc && typeof merged.webrtc === "object" ? merged.webrtc : {};
    const tlsOptions = merged.tls && typeof merged.tls === "object" ? merged.tls : {};
    const storageOptions = merged.storage && typeof merged.storage === "object" ? merged.storage : {};
    const protectionOptions = merged.protection && typeof merged.protection === "object" ? merged.protection : {};
    const browser = ua.browser || "firefox";
    const isChromium = browser === "chromium";
    const chromeBrandInfo = chromeBrands(ua.chromeMajor || majorVersion(ua.chromeVersion, majorVersion(safe(() => Services.appinfo.version, ""), 128)), ua.chromeVersion);
    const webglDefaults = this._webglDefaults(ua.os, browser);
    const fontDefaults = this._fontDefaults(ua.os);
    const language = String(merged.language || defaults.language || "en-US").trim() || "en-US";
    const languages = normalizeLanguages(language, merged.languages);
    const resolution = parseResolution(merged.resolution, defaults.resolution);
    const availWidth = clampInt(merged.availWidth, 320, 10000, resolution.width);
    const availHeight = clampInt(merged.availHeight, 240, 10000, Math.max(240, resolution.height - (ua.os === "windows" ? 40 : 28)));
    const dpr = clampNumber(merged.devicePixelRatio, 0.5, 5, defaults.devicePixelRatio || 1);
    const hc = clampInt(merged.hardwareConcurrency, 1, 128, defaults.hardwareConcurrency || 8);
    const timezone = String(merged.timezone || defaults.timezone || "UTC").trim() || "UTC";
    const locale = String(merged.locale || language).trim() || language;
    const userAgent = String(merged.userAgent || ua.userAgent);
    const platform = String(merged.platform || ua.platform);
    const acceptLanguage = String(merged.acceptLanguage || acceptLanguageFrom(languages));
    const defaultUserAgentData = isChromium
      ? {
          brands: chromeBrandInfo.brands,
          mobile: false,
          platform: ua.uaPlatform,
          architecture: "x86",
          bitness: "64",
          model: "",
          platformVersion: ua.os === "windows" ? "10.0.0" : ua.os === "macos" ? "15.0.0" : "6.0.0",
          fullVersionList: chromeBrandInfo.fullVersionList,
        }
      : null;
    const chromePlugins = isChromium
      ? [
          { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimeTypes: ["application/pdf", "text/pdf"] },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimeTypes: ["application/pdf", "text/pdf"] },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimeTypes: ["application/pdf", "text/pdf"] },
          { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", mimeTypes: ["application/pdf", "text/pdf"] },
          { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format", mimeTypes: ["application/pdf", "text/pdf"] },
        ]
      : [];
    const chromeMimeTypes = isChromium
      ? [
          { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: "PDF Viewer" },
          { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: "PDF Viewer" },
        ]
      : [];
    const sampleRate = clampInt(merged.audioSampleRate || configField(audioOptions, "sampleRate", 48000), 8000, 192000, 48000);
    const fontVisibility = clampInt(merged.fontVisibility || configField(fontsOptions, "visibility", 3), 1, 3, 3);
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: merged.enabled !== false,
      seed_mode: env.seedMode || "persistent",
      seed: env.seed,
      source: {
        type: source.type || "generated",
        browser,
        createdAt: nowISO(),
        options: {
          browser,
          os: ua.os,
          firefoxVersion: normalizeVersion(merged.firefoxVersion || merged.version, normalizeVersion(safe(() => Services.appinfo.version, ""), "128.0")),
          ...(isChromium ? { chromeVersion: ua.chromeVersion } : {}),
          language,
          resolution: `${resolution.width}x${resolution.height}`,
          timezone,
          devicePixelRatio: dpr,
          hardwareConcurrency: hc,
          ...(options && options.randomize ? { randomize: true } : {}),
        },
        ...(source.path ? { path: source.path } : {}),
        ...(source.capturedBrowser ? { capturedBrowser: source.capturedBrowser } : {}),
        ...(source.normalizedBrowser ? { normalizedBrowser: source.normalizedBrowser } : {}),
        ...(source.normalizedFromNonFirefox ? { normalizedFromNonFirefox: true } : {}),
      },
      trace: {
        enabled: true,
        dir: env.traceDir,
        jsvmp_dir: PathUtils.join(env.traceDir, "jsvmp"),
        network_dir: PathUtils.join(env.traceDir, "network"),
        property_dir: PathUtils.join(env.traceDir, "property"),
        js_dir: PathUtils.join(env.traceDir, "js"),
      },
      navigator: {
        userAgent: field(userAgent),
        platform: field(platform),
        language: field(language),
        languages: field(languages),
        webdriver: field(false),
        hardwareConcurrency: field(hc),
        appCodeName: field(configString(navigatorOptions, "appCodeName", "Mozilla")),
        appName: field(configString(navigatorOptions, "appName", "Netscape")),
        appVersion: field(configString(navigatorOptions, "appVersion", userAgent.replace(/^Mozilla\//, ""))),
        product: field(configString(navigatorOptions, "product", "Gecko")),
        productSub: field(configString(navigatorOptions, "productSub", isChromium ? "20030107" : "20100101")),
        vendor: field(configString(navigatorOptions, "vendor", isChromium ? "Google Inc." : "")),
        vendorSub: field(configString(navigatorOptions, "vendorSub", "")),
        maxTouchPoints: field(configInt(navigatorOptions, "maxTouchPoints", 0, 32, ua.os === "windows" ? 0 : 0)),
        cookieEnabled: field(configBool(navigatorOptions, "cookieEnabled", true)),
        pdfViewerEnabled: field(configBool(navigatorOptions, "pdfViewerEnabled", true)),
        doNotTrack: field(configField(navigatorOptions, "doNotTrack", null), configField(navigatorOptions, "doNotTrack", null) != null),
        oscpu: field(configString(navigatorOptions, "oscpu", ""), configField(navigatorOptions, "oscpu", null) != null),
        buildID: field(configString(navigatorOptions, "buildID", ""), configField(navigatorOptions, "buildID", null) != null),
        userAgentData: field(configJSON(navigatorOptions, "userAgentData", defaultUserAgentData), isChromium || configField(navigatorOptions, "userAgentData", null) != null),
        plugins: field(configArray(navigatorOptions, "plugins", chromePlugins)),
        mimeTypes: field(configArray(navigatorOptions, "mimeTypes", chromeMimeTypes)),
      },
      screen: {
        enabled: true,
        width: field(resolution.width),
        height: field(resolution.height),
        availWidth: field(availWidth),
        availHeight: field(availHeight),
        colorDepth: field(clampInt(merged.colorDepth, 1, 48, 24)),
        pixelDepth: field(clampInt(merged.pixelDepth, 1, 48, 24)),
        orientation: field(configJSON(screenOptions, "orientation", { type: "landscape-primary", angle: 0 })),
      },
      window: {
        devicePixelRatio: field(dpr),
        innerWidth: field(configInt(windowOptions, "innerWidth", 1, 10000, resolution.width), configField(windowOptions, "innerWidth", null) != null),
        innerHeight: field(configInt(windowOptions, "innerHeight", 1, 10000, Math.max(1, resolution.height - 120)), configField(windowOptions, "innerHeight", null) != null),
        outerWidth: field(configInt(windowOptions, "outerWidth", 1, 10000, resolution.width), configField(windowOptions, "outerWidth", null) != null),
        outerHeight: field(configInt(windowOptions, "outerHeight", 1, 10000, resolution.height), configField(windowOptions, "outerHeight", null) != null),
      },
      intl: {
        locale: field(locale),
        timezone: field(timezone),
        calendar: field(configString(intlOptions, "calendar", "gregory")),
        numberingSystem: field(configString(intlOptions, "numberingSystem", "latn")),
        timezoneOffset: field(configInt(intlOptions, "timezoneOffset", -1440, 1440, 0), configField(intlOptions, "timezoneOffset", null) != null),
      },
      http: {
        userAgent: field(userAgent),
        acceptLanguage: field(acceptLanguage),
        secChUa: field(configString(httpOptions, "secChUa", isChromium ? secChUaFromBrands(chromeBrandInfo.brands) : ""), isChromium || configField(httpOptions, "secChUa", null) != null),
        secChUaMobile: field(configString(httpOptions, "secChUaMobile", "?0"), isChromium || configField(httpOptions, "secChUaMobile", null) != null),
        secChUaPlatform: field(configString(httpOptions, "secChUaPlatform", isChromium ? `"${ua.uaPlatform}"` : ""), isChromium || configField(httpOptions, "secChUaPlatform", null) != null),
        secChUaFullVersionList: field(configString(httpOptions, "secChUaFullVersionList", isChromium ? secChUaFromBrands(chromeBrandInfo.fullVersionList) : ""), isChromium || configField(httpOptions, "secChUaFullVersionList", null) != null),
        secChUaArch: field(configString(httpOptions, "secChUaArch", isChromium ? '"x86"' : ""), isChromium || configField(httpOptions, "secChUaArch", null) != null),
        secChUaBitness: field(configString(httpOptions, "secChUaBitness", isChromium ? '"64"' : ""), isChromium || configField(httpOptions, "secChUaBitness", null) != null),
        secChUaModel: field(configString(httpOptions, "secChUaModel", isChromium ? '""' : ""), isChromium || configField(httpOptions, "secChUaModel", null) != null),
        secChUaPlatformVersion: field(configString(httpOptions, "secChUaPlatformVersion", isChromium ? `"${defaultUserAgentData.platformVersion}"` : ""), isChromium || configField(httpOptions, "secChUaPlatformVersion", null) != null),
      },
      webgl: {
        enabled: configBool(webglOptions, "enabled", true),
        vendor: field(configString(webglOptions, "vendor", webglDefaults.vendor)),
        renderer: field(configString(webglOptions, "renderer", webglDefaults.renderer)),
        unmaskedVendor: field(configString(webglOptions, "unmaskedVendor", webglDefaults.unmaskedVendor)),
        unmaskedRenderer: field(configString(webglOptions, "unmaskedRenderer", webglDefaults.unmaskedRenderer)),
        antialias: field(configField(webglOptions, "antialias", null), configField(webglOptions, "antialias", null) != null),
        redBits: field(configInt(webglOptions, "redBits", 0, 64, 8), configField(webglOptions, "redBits", null) != null),
        greenBits: field(configInt(webglOptions, "greenBits", 0, 64, 8), configField(webglOptions, "greenBits", null) != null),
        blueBits: field(configInt(webglOptions, "blueBits", 0, 64, 8), configField(webglOptions, "blueBits", null) != null),
        alphaBits: field(configInt(webglOptions, "alphaBits", 0, 64, 8), configField(webglOptions, "alphaBits", null) != null),
        depthBits: field(configInt(webglOptions, "depthBits", 0, 64, 24), configField(webglOptions, "depthBits", null) != null),
        stencilBits: field(configInt(webglOptions, "stencilBits", 0, 64, 8), configField(webglOptions, "stencilBits", null) != null),
        sanitizeUnmaskedRenderer: field(configBool(webglOptions, "sanitizeUnmaskedRenderer", true)),
        powerPreferenceOverride: field(configInt(webglOptions, "powerPreferenceOverride", 0, 2, 0)),
        extensionsPolicy: field(configString(webglOptions, "extensionsPolicy", "native")),
        maxTextureSize: field(configInt(webglOptions, "maxTextureSize", 0, 262144, 0), configField(webglOptions, "maxTextureSize", null) != null),
        maxViewportDims: field(configArray(webglOptions, "maxViewportDims", []), configField(webglOptions, "maxViewportDims", null) != null),
        aliasedLineWidthRange: field(configArray(webglOptions, "aliasedLineWidthRange", []), configField(webglOptions, "aliasedLineWidthRange", null) != null),
        aliasedPointSizeRange: field(configArray(webglOptions, "aliasedPointSizeRange", []), configField(webglOptions, "aliasedPointSizeRange", null) != null),
        maxAnisotropy: field(configInt(webglOptions, "maxAnisotropy", 0, 1024, 0), configField(webglOptions, "maxAnisotropy", null) != null),
        maxCombinedTextureImageUnits: field(configInt(webglOptions, "maxCombinedTextureImageUnits", 0, 1024, 0), configField(webglOptions, "maxCombinedTextureImageUnits", null) != null),
        maxCubeMapTextureSize: field(configInt(webglOptions, "maxCubeMapTextureSize", 0, 262144, 0), configField(webglOptions, "maxCubeMapTextureSize", null) != null),
        maxFragmentUniformVectors: field(configInt(webglOptions, "maxFragmentUniformVectors", 0, 262144, 0), configField(webglOptions, "maxFragmentUniformVectors", null) != null),
        maxRenderbufferSize: field(configInt(webglOptions, "maxRenderbufferSize", 0, 262144, 0), configField(webglOptions, "maxRenderbufferSize", null) != null),
        maxTextureImageUnits: field(configInt(webglOptions, "maxTextureImageUnits", 0, 1024, 0), configField(webglOptions, "maxTextureImageUnits", null) != null),
        maxVaryingVectors: field(configInt(webglOptions, "maxVaryingVectors", 0, 262144, 0), configField(webglOptions, "maxVaryingVectors", null) != null),
        maxVertexAttribs: field(configInt(webglOptions, "maxVertexAttribs", 0, 1024, 0), configField(webglOptions, "maxVertexAttribs", null) != null),
        maxVertexTextureImageUnits: field(configInt(webglOptions, "maxVertexTextureImageUnits", 0, 1024, 0), configField(webglOptions, "maxVertexTextureImageUnits", null) != null),
        maxVertexUniformVectors: field(configInt(webglOptions, "maxVertexUniformVectors", 0, 262144, 0), configField(webglOptions, "maxVertexUniformVectors", null) != null),
        extensions: field(configArray(webglOptions, "extensions", []), configField(webglOptions, "extensions", null) != null),
      },
      canvas: {
        enabled: configBool(canvasOptions, "enabled", true),
        mode: field(configString(canvasOptions, "mode", "native")),
        seed: field(configString(canvasOptions, "seed", env.seed)),
        noise: field(configNumber(canvasOptions, "noise", 0, 1, 0)),
        capturedHash: field(configString(canvasOptions, "hash", ""), configField(canvasOptions, "hash", "") !== ""),
        capturedDataUrlLength: field(configInt(canvasOptions, "dataUrlLength", 0, 100000000, 0), configField(canvasOptions, "dataUrlLength", null) != null),
      },
      audio: {
        enabled: configBool(audioOptions, "enabled", true),
        mode: field(configString(audioOptions, "mode", "native")),
        sampleRate: field(sampleRate),
        seed: field(configString(audioOptions, "seed", env.seed)),
        noise: field(configNumber(audioOptions, "noise", 0, 1, 0)),
        baseLatency: field(configNumber(audioOptions, "baseLatency", 0, 10, 0), configField(audioOptions, "baseLatency", null) != null),
        outputLatency: field(configNumber(audioOptions, "outputLatency", 0, 10, 0), configField(audioOptions, "outputLatency", null) != null),
      },
      fonts: {
        enabled: configBool(fontsOptions, "enabled", true),
        mode: field(configString(fontsOptions, "mode", "native")),
        visibility: field(fontVisibility),
        families: field(Array.isArray(fontsOptions.families) ? fontsOptions.families : fontDefaults),
      },
      webrtc: {
        enabled: configBool(webrtcOptions, "enabled", true),
        mode: field(configString(webrtcOptions, "mode", "default_address_only")),
        noHost: field(configBool(webrtcOptions, "noHost", true)),
        defaultAddressOnly: field(configBool(webrtcOptions, "defaultAddressOnly", true)),
        obfuscateHostAddresses: field(configBool(webrtcOptions, "obfuscateHostAddresses", true)),
        proxyOnly: field(configBool(webrtcOptions, "proxyOnly", false)),
        proxyOnlyIfBehindProxy: field(configBool(webrtcOptions, "proxyOnlyIfBehindProxy", true)),
        relayOnly: field(configBool(webrtcOptions, "relayOnly", false)),
      },
      tls: {
        enabled: configBool(tlsOptions, "enabled", true),
        mode: field(configString(tlsOptions, "mode", "firefox-default")),
        minVersion: field(configInt(tlsOptions, "minVersion", 1, 4, 3)),
        maxVersion: field(configInt(tlsOptions, "maxVersion", 1, 4, 4)),
        http3: field(configBool(tlsOptions, "http3", true)),
        alpn: field(configBool(tlsOptions, "alpn", true)),
        zeroRtt: field(configBool(tlsOptions, "zeroRtt", false)),
        echGrease: field(configBool(tlsOptions, "echGrease", true)),
        echGreaseProbability: field(configInt(tlsOptions, "echGreaseProbability", 0, 100, 100)),
        kyber: field(configBool(tlsOptions, "kyber", true)),
      },
      protection: {
        resistFingerprinting: field(configBool(protectionOptions, "resistFingerprinting", false)),
        fingerprintingProtection: field(configBool(protectionOptions, "fingerprintingProtection", false)),
      },
      proxyConsistency: {
        enabled: true,
        remoteDns: field(true),
        bindWebrtcToProxy: field(true),
      },
      storage: {
        localStorage: field(configBool(storageOptions, "localStorage", true)),
        sessionStorage: field(configBool(storageOptions, "sessionStorage", true)),
        indexedDB: field(configBool(storageOptions, "indexedDB", true)),
        cookie: field(configString(storageOptions, "cookie", ""), configField(storageOptions, "cookie", null) != null),
      },
    };
  }

  _defaultFingerprint(env) {
    return this._buildFingerprint(env, { enabled: true }, { type: "generated-default" });
  }

  _defaultProxy() {
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: false,
      default: {
        type: "direct",
        host: "",
        port: 0,
        username: "",
        password: "",
        remote_dns: true,
      },
      rules: [],
      fallback_on_failure: true,
      no_proxy_for: ["localhost", "127.0.0.1", "::1"],
      dns: {
        socks_remote_dns: true,
      },
      webrtc: {
        prevent_local_ip_leak: true,
        proxy_only_if_behind_proxy: true,
      },
    };
  }

  _fingerprintUserPrefs(fingerprint = {}) {
    const lines = [];
    if (!fingerprint || fingerprint.enabled === false) {
      return lines;
    }

    const webgl = fingerprint.webgl || {};
    if (webgl.enabled !== false) {
      const unmaskedVendor = configString(webgl, "unmaskedVendor", "");
      const unmaskedRenderer = configString(webgl, "unmaskedRenderer", "");
      if (unmaskedVendor) {
        pushUserPref(lines, "webgl.override-unmasked-vendor", unmaskedVendor);
      }
      if (unmaskedRenderer) {
        pushUserPref(lines, "webgl.override-unmasked-renderer", unmaskedRenderer);
      }
      pushUserPref(lines, "webgl.sanitize-unmasked-renderer", configBool(webgl, "sanitizeUnmaskedRenderer", true));
      pushUserPref(lines, "webgl.power-preference-override", configInt(webgl, "powerPreferenceOverride", 0, 2, 0));
    }

    const audio = fingerprint.audio || {};
    if (audio.enabled !== false) {
      const sampleRate = configInt(audio, "sampleRate", 8000, 192000, 0);
      if (sampleRate) {
        pushUserPref(lines, "media.cubeb.force_sample_rate", sampleRate);
      }
    }

    const fonts = fingerprint.fonts || {};
    if (fonts.enabled !== false) {
      pushUserPref(lines, "layout.css.font-visibility", configInt(fonts, "visibility", 1, 3, 3));
    }

    const webrtc = fingerprint.webrtc || {};
    if (webrtc.enabled === false || configString(webrtc, "mode", "") === "disabled") {
      pushUserPref(lines, "media.peerconnection.enabled", false);
    } else {
      const mode = configString(webrtc, "mode", "default_address_only");
      pushUserPref(lines, "media.peerconnection.enabled", true);
      pushUserPref(lines, "media.peerconnection.ice.no_host", configBool(webrtc, "noHost", true));
      pushUserPref(lines, "media.peerconnection.ice.default_address_only", configBool(webrtc, "defaultAddressOnly", true));
      pushUserPref(lines, "media.peerconnection.ice.obfuscate_host_addresses", configBool(webrtc, "obfuscateHostAddresses", true));
      pushUserPref(lines, "media.peerconnection.ice.proxy_only", configBool(webrtc, "proxyOnly", mode === "proxy_only"));
      pushUserPref(lines, "media.peerconnection.ice.proxy_only_if_behind_proxy", configBool(webrtc, "proxyOnlyIfBehindProxy", true));
      pushUserPref(lines, "media.peerconnection.ice.relay_only", configBool(webrtc, "relayOnly", mode === "relay_only"));
    }

    const tls = fingerprint.tls || {};
    if (tls.enabled !== false) {
      pushUserPref(lines, "security.tls.version.min", configInt(tls, "minVersion", 1, 4, 3));
      pushUserPref(lines, "security.tls.version.max", configInt(tls, "maxVersion", 1, 4, 4));
      pushUserPref(lines, "network.http.http3.enable", configBool(tls, "http3", true));
      pushUserPref(lines, "network.http.http3.enable_0rtt", configBool(tls, "zeroRtt", false));
      pushUserPref(lines, "security.tls.enable_0rtt_data", configBool(tls, "zeroRtt", false));
      pushUserPref(lines, "security.ssl.enable_alpn", configBool(tls, "alpn", true));
      pushUserPref(lines, "security.tls.ech.grease_probability", configInt(tls, "echGreaseProbability", 0, 100, 100));
      pushUserPref(lines, "security.tls.ech.grease_http3", configBool(tls, "echGrease", true));
      pushUserPref(lines, "security.tls.grease_http3_enable", configBool(tls, "echGrease", true));
      pushUserPref(lines, "security.tls.enable_kyber", configBool(tls, "kyber", true));
    }

    const protection = fingerprint.protection || {};
    if (Object.keys(protection).length) {
      pushUserPref(lines, "privacy.resistFingerprinting", configBool(protection, "resistFingerprinting", false));
      pushUserPref(lines, "privacy.fingerprintingProtection", configBool(protection, "fingerprintingProtection", false));
    }
    return lines;
  }

  _proxyUserPrefs(proxy = {}, fingerprint = {}) {
    const lines = [];
    const def = proxy && typeof proxy.default === "object" ? proxy.default : {};
    const enabled = proxy && proxy.enabled === true;
    const type = enabled ? proxyTypeOf(proxy) : "direct";
    const noProxy = Array.isArray(proxy.no_proxy_for)
      ? proxy.no_proxy_for.join(",")
      : String(proxy.no_proxy_for || "localhost,127.0.0.1,::1");

    pushUserPref(lines, "network.proxy.no_proxies_on", noProxy);

    if (type === "direct" || !enabled) {
      pushUserPref(lines, "network.proxy.type", 0);
      return lines;
    }
    if (type === "system") {
      pushUserPref(lines, "network.proxy.type", 5);
      return lines;
    }
    if (type === "wpad" || type === "auto-detect") {
      pushUserPref(lines, "network.proxy.type", 4);
      pushUserPref(lines, "network.proxy.system_wpad", true);
      return lines;
    }
    if (type === "pac") {
      pushUserPref(lines, "network.proxy.type", 2);
      pushUserPref(lines, "network.proxy.autoconfig_url", String(def.pacUrl || def.url || ""));
      return lines;
    }

    pushUserPref(lines, "network.proxy.type", 1);
    const host = String(def.host || "");
    const port = clampInt(def.port, 0, 65535, 0);
    const remoteDns = def.remote_dns !== false && proxy.dns?.socks_remote_dns !== false;

    const setHostPort = (kind, value) => {
      if (!value || typeof value !== "object") {
        return;
      }
      const h = String(value.host || "");
      const p = clampInt(value.port, 0, 65535, 0);
      if (h) {
        pushUserPref(lines, `network.proxy.${kind}`, h);
      }
      if (p) {
        pushUserPref(lines, `network.proxy.${kind}_port`, p);
      }
    };

    if (type === "http" || type === "manual") {
      if (host) {
        pushUserPref(lines, "network.proxy.http", host);
      }
      if (port) {
        pushUserPref(lines, "network.proxy.http_port", port);
      }
      if (def.applyToHttps !== false) {
        if (host) {
          pushUserPref(lines, "network.proxy.ssl", host);
        }
        if (port) {
          pushUserPref(lines, "network.proxy.ssl_port", port);
        }
      }
    } else if (type === "https" || type === "ssl") {
      if (host) {
        pushUserPref(lines, "network.proxy.ssl", host);
      }
      if (port) {
        pushUserPref(lines, "network.proxy.ssl_port", port);
      }
    } else if (type === "socks" || type === "socks4" || type === "socks5") {
      if (host) {
        pushUserPref(lines, "network.proxy.socks", host);
      }
      if (port) {
        pushUserPref(lines, "network.proxy.socks_port", port);
      }
      pushUserPref(lines, "network.proxy.socks_version", type === "socks4" ? 4 : 5);
    }

    setHostPort("http", proxy.http);
    setHostPort("ssl", proxy.ssl || proxy.https);
    setHostPort("socks", proxy.socks);
    if (proxy.socks?.version) {
      pushUserPref(lines, "network.proxy.socks_version", clampInt(proxy.socks.version, 4, 5, 5));
    }
    pushUserPref(lines, "network.proxy.socks_remote_dns", remoteDns);
    pushUserPref(lines, "network.proxy.socks5_remote_dns", remoteDns);
    if (proxy.fallback_on_failure === false) {
      pushUserPref(lines, "network.proxy.failover_direct", false);
    }

    const webrtc = fingerprint.webrtc || {};
    const consistency = fingerprint.proxyConsistency || {};
    if (configBool(consistency, "bindWebrtcToProxy", true) && webrtc.enabled !== false) {
      pushUserPref(lines, "media.peerconnection.ice.proxy_only_if_behind_proxy", true);
      pushUserPref(lines, "media.peerconnection.ice.proxy_only", configBool(webrtc, "proxyOnly", true));
      pushUserPref(lines, "media.peerconnection.ice.no_host", true);
      pushUserPref(lines, "media.peerconnection.ice.default_address_only", true);
    }

    return lines;
  }

  _profileUserJs(env, port = null, runtimeConfig = {}) {
    const p = env ? this._paths(env.id) : null;
    const lines = [
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("browser.tabs.warnOnClose", false);',
      'user_pref("browser.startup.page", 0);',
      'user_pref("frx.hideRemoteControlCue", true);',
      'user_pref("sidebar.position_start", false);',
      'user_pref("sidebar.revamp", true);',
      'user_pref("sidebar.verticalTabs", false);',
      'user_pref("sidebar.visibility", "always-show");',
      'user_pref("frx.forceHorizontalTabs", true);',
      'user_pref("sidebar.main.tools", "agent");',
      'user_pref("sidebar.newTool.migration.agent", "{\\"alreadyShown\\":true}");',
      'user_pref("browser.ml.chat.enabled", false);',
    ];
    pushUserPrefs(lines, AUTOMATION_STEALTH_PREFS);
    if (p) {
      lines.push(`user_pref("frx.fingerprint.config.path", ${JSON.stringify(p.runtimeFingerprintPath)});`);
      lines.push(`user_pref("frx.fingerprint.config.json", ${JSON.stringify(JSON.stringify(runtimeConfig.fingerprint || {}))});`);
      lines.push(`user_pref("frx.proxy.config.path", ${JSON.stringify(p.runtimeProxyPath)});`);
      lines.push(`user_pref("frx.environment.id", ${JSON.stringify(env.id)});`);
      lines.push(`user_pref("frx.environment.name", ${JSON.stringify(envDisplayName(env))});`);
      lines.push(`user_pref("frx.process.label", ${JSON.stringify(port != null ? processSlotLabel(port) : processLabelFor(env))});`);
    }
    if (port != null) {
      lines.push(`user_pref("marionette.port", ${Number(port) | 0});`);
    }
    lines.push(...this._fingerprintUserPrefs(runtimeConfig.fingerprint || {}));
    lines.push(...this._proxyUserPrefs(runtimeConfig.proxy || {}, runtimeConfig.fingerprint || {}));
    return lines.join("\n") + "\n";
  }

  async _writeProfilePrefs(env, port = null, runtimeConfig = null) {
    await IOUtils.makeDirectory(env.profilePath, { ignoreExisting: true, createAncestors: true });
    const config =
      runtimeConfig || {
        fingerprint: await this._readJSON(env.fingerprintPath, this._defaultFingerprint(env)),
        proxy: await this._readJSON(env.proxyPath, this._defaultProxy()),
      };
    await IOUtils.writeUTF8(this._paths(env.id).profileUserJsPath, this._profileUserJs(env, port, config), {
      tmpPath: this._paths(env.id).profileUserJsPath + ".tmp",
    });
  }

  async _syncProfileRuntimeConfig(env) {
    const p = this._paths(env.id);
    await IOUtils.makeDirectory(p.profileFrxDir, { ignoreExisting: true, createAncestors: true });
    const fingerprint = await this._readJSON(env.fingerprintPath, this._defaultFingerprint(env));
    const proxy = await this._readJSON(env.proxyPath, this._defaultProxy());
    await this._writeJSON(p.runtimeFingerprintPath, fingerprint);
    await this._writeJSON(p.runtimeProxyPath, proxy);
    return {
      fingerprintPath: p.runtimeFingerprintPath,
      proxyPath: p.runtimeProxyPath,
      fingerprint,
      proxy,
    };
  }

  _currentProcessDefaultFingerprint(env) {
    return this._buildFingerprint(env, { enabled: false }, { type: "current-process-default" });
  }

  async _readOrCreateCurrentProcessConfig(type = "fingerprint") {
    const env = await this._currentProcessEnv();
    const p = this._currentProcessPaths();
    const t = String(type || "fingerprint").toLowerCase();
    const path = t === "proxy" ? p.proxyPath : p.fingerprintPath;
    let config = await this._readJSON(path, null);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = t === "proxy" ? this._defaultProxy() : this._currentProcessDefaultFingerprint(env);
      await this._writeJSON(path, config);
    }
    return { env, paths: p, type: t, path, config };
  }

  async _upsertCurrentProfileUserJs(fingerprint, proxy) {
    const env = await this._currentProcessEnv();
    const p = this._currentProcessPaths();
    if (!p.profileUserJsPath) {
      throw new Error("cannot locate current profile user.js");
    }
    await IOUtils.makeDirectory(p.profilePath, { ignoreExisting: true, createAncestors: true });
    const prefLines = [
      `user_pref("frx.fingerprint.config.path", ${JSON.stringify(p.runtimeFingerprintPath || p.fingerprintPath)});`,
      `user_pref("frx.fingerprint.config.json", ${JSON.stringify(JSON.stringify(fingerprint || {}))});`,
      `user_pref("frx.proxy.config.path", ${JSON.stringify(p.runtimeProxyPath || p.proxyPath)});`,
      `user_pref("frx.current_process.fingerprint.enabled", true);`,
      ...this._fingerprintUserPrefs(fingerprint || {}),
      ...this._proxyUserPrefs(proxy || {}, fingerprint || {}),
    ];
    const names = userPrefNames(prefLines);
    let oldText = "";
    try {
      oldText = await IOUtils.readUTF8(p.profileUserJsPath);
    } catch {
      oldText = "";
    }
    oldText = oldText.replace(
      new RegExp(`${USERJS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${USERJS_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"),
      ""
    );
    const kept = oldText
      .split(/\r?\n/)
      .filter(line => {
        const m = String(line).match(/user_pref\("([^"]+)"/);
        return !m || !names.has(m[1]);
      })
      .join("\n")
      .replace(/\s+$/g, "");
    const block = [USERJS_BLOCK_START, ...prefLines, USERJS_BLOCK_END].join("\n");
    const next = (kept ? kept + "\n\n" : "") + block + "\n";
    await IOUtils.writeUTF8(p.profileUserJsPath, next, { tmpPath: p.profileUserJsPath + ".tmp" });
    if (p.runtimeFingerprintPath) {
      await this._writeJSON(p.runtimeFingerprintPath, fingerprint || {});
    }
    if (p.runtimeProxyPath) {
      await this._writeJSON(p.runtimeProxyPath, proxy || {});
    }
    try {
      Services.prefs.setStringPref("frx.fingerprint.config.path", p.runtimeFingerprintPath || p.fingerprintPath);
      Services.prefs.setStringPref("frx.fingerprint.config.json", JSON.stringify(fingerprint || {}));
      Services.prefs.setStringPref("frx.proxy.config.path", p.runtimeProxyPath || p.proxyPath);
      Services.prefs.setBoolPref("frx.current_process.fingerprint.enabled", true);
    } catch {
      /* runtime pref update is best-effort; C++ fingerprint config is startup-cached */
    }
    env.updatedAt = nowISO();
    await this._writeJSON(p.metaPath, {
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

  async _removeCurrentProfileUserJsBlock() {
    const p = this._currentProcessPaths();
    if (!p.profileUserJsPath) {
      throw new Error("cannot locate current profile user.js");
    }
    let oldText = "";
    try {
      oldText = await IOUtils.readUTF8(p.profileUserJsPath);
    } catch {
      oldText = "";
    }
    const blockRe = new RegExp(`${USERJS_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${USERJS_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
    const namesToClear = new Set([
      "frx.fingerprint.config.path",
      "frx.fingerprint.config.json",
      "frx.proxy.config.path",
      "frx.current_process.fingerprint.enabled",
    ]);
    for (const match of oldText.matchAll(blockRe)) {
      for (const name of userPrefNames(String(match[0]).split(/\r?\n/))) {
        namesToClear.add(name);
      }
    }
    const next = oldText
      .replace(blockRe, "")
      .split(/\r?\n/)
      .filter(line => {
        const m = String(line).match(/user_pref\("([^"]+)"/);
        return !m || !namesToClear.has(m[1]);
      })
      .join("\n")
      .replace(/\s+$/g, "");
    await IOUtils.writeUTF8(p.profileUserJsPath, (next ? next + "\n" : ""), {
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

  async create({ id, name, generateOptions = null } = {}) {
    await this._ensureRoot();
    const finalName = String(name || "").trim() || "New Environment";
    const envId = id ? String(id).trim() : this._newId(finalName);
    this._validateId(envId);
    const p = this._paths(envId);
    if (await IOUtils.exists(p.envPath)) {
      throw new Error("environment already exists: " + envId);
    }
    for (const dir of [p.rootPath, p.profilePath, p.traceDir, p.controlDir, p.capturesDir, p.logsDir]) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    const ts = nowISO();
    const requestedBrowser = generateOptions
      ? normalizeBrowserFamily(generateOptions.browser || generateOptions.browserFamily, generateOptions.randomize ? "chromium" : "firefox")
      : "firefox";
    const env = {
      schemaVersion: SCHEMA_VERSION,
      id: envId,
      name: finalName,
      browserFamily: requestedBrowser,
      createdAt: ts,
      updatedAt: ts,
      rootPath: p.rootPath,
      profilePath: p.profilePath,
      fingerprintPath: p.fingerprintPath,
      proxyPath: p.proxyPath,
      traceDir: p.traceDir,
      controlDir: p.controlDir,
      capturesDir: p.capturesDir,
      logsDir: p.logsDir,
      seed: randHex(16),
      seedMode: "persistent",
      source: {
        type: generateOptions ? "generated" : "generated-default",
        browser: requestedBrowser,
        createdAt: ts,
        ...(generateOptions ? { options: generateOptions } : {}),
      },
      processLabel: null,
      runtime: {
        status: "stopped",
        pid: null,
        marionettePort: null,
        lastStartedAt: null,
        lastStoppedAt: null,
        lastUrl: null,
        processLabel: null,
      },
    };
    env.processLabel = processLabelFor(env);
    env.runtime.processLabel = env.processLabel;
    const fingerprint = generateOptions
      ? this._buildFingerprint(env, generateOptions, { type: "generated" })
      : this._defaultFingerprint(env);
    await this._writeJSON(p.fingerprintPath, fingerprint);
    await this._writeJSON(p.proxyPath, this._defaultProxy());
    const runtimeConfig = await this._syncProfileRuntimeConfig(env);
    await this._writeProfilePrefs(env, null, runtimeConfig);
    await this._writeJSON(p.runtimePath, env.runtime);
    await this._saveEnv(env);
    return { ok: true, environment: shortEnv(env) };
  }

  async currentProcess({ refresh = true } = {}) {
    const env = await this._currentProcessEnv();
    const p = this._currentProcessPaths();
    const currentEnvId = this._currentEnvId();
    let managedEnvironment = null;
    let managedError = "";
    if (currentEnvId) {
      try {
        const managed = refresh === false ? await this._loadEnv(currentEnvId) : await this._refreshRuntime(await this._loadEnv(currentEnvId));
        managedEnvironment = shortEnv(managed);
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
      root: this._root,
      profilePath: p.profilePath,
      fingerprintPath: p.fingerprintPath,
      proxyPath: p.proxyPath,
      activeFingerprintPath: envConfigPath || prefConfigPath || "",
      activeProxyPath: safe(() => Services.env.get("MOZ_FRX_PROXY_CONFIG"), "") || proxyPrefPath || "",
      hasInlineFingerprint: !!envInline,
      managedEnvId: currentEnvId || null,
      managedEnvironment,
      managedError,
      editable: !currentEnvId,
      needsRestartOnWrite: true,
      runtime: env.runtime,
    };
  }

  async readCurrentProcessConfig({ type = "fingerprint" } = {}) {
    const res = await this._readOrCreateCurrentProcessConfig(type);
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

  async writeCurrentProcessConfig({ type = "fingerprint", config, text } = {}) {
    const res = await this._readOrCreateCurrentProcessConfig(type);
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("config must be a JSON object");
    }
    data.schemaVersion = data.schemaVersion || SCHEMA_VERSION;
    data.updatedAt = nowISO();
    await this._writeJSON(res.path, data);
    const fingerprint =
      res.type === "fingerprint"
        ? data
        : (await this._readOrCreateCurrentProcessConfig("fingerprint")).config;
    const proxy =
      res.type === "proxy"
        ? data
        : (await this._readOrCreateCurrentProcessConfig("proxy")).config;
    await this._upsertCurrentProfileUserJs(fingerprint, proxy);
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

  async generateCurrentProcessFingerprint({ options = {} } = {}) {
    const env = await this._currentProcessEnv();
    const p = this._currentProcessPaths();
    const fingerprint = this._buildFingerprint(env, options, { type: "generated", target: CURRENT_PROCESS_ID });
    await this._writeJSON(p.fingerprintPath, fingerprint);
    const proxy = (await this._readOrCreateCurrentProcessConfig("proxy")).config;
    await this._upsertCurrentProfileUserJs(fingerprint, proxy);
    return {
      ok: true,
      id: CURRENT_PROCESS_ID,
      path: p.fingerprintPath,
      profilePath: p.profilePath,
      fingerprint,
      needsRestart: true,
    };
  }

  async _latestCurrentProcessCapturePath() {
    const p = this._currentProcessPaths();
    let children = [];
    try {
      children = await IOUtils.getChildren(p.capturesDir);
    } catch {
      return "";
    }
    const captures = (children || []).filter(x => String(x).endsWith(".json")).sort();
    return captures.length ? captures[captures.length - 1] : "";
  }

  async importCurrentProcessFingerprint({ capturePath, capture, text } = {}) {
    const env = await this._currentProcessEnv();
    const p = this._currentProcessPaths();
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
        finalPath = await this._latestCurrentProcessCapturePath();
      } else if (!finalPath.includes("/") && !finalPath.includes("\\")) {
        finalPath = PathUtils.join(p.capturesDir, finalPath);
      }
      if (!finalPath) {
        throw new Error("no capture found to import");
      }
      finalCapture = await this._readJSON(finalPath, null);
    }
    if (!finalCapture || typeof finalCapture !== "object") {
      throw new Error("capture must be a JSON object");
    }
    if (!finalPath) {
      await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
      finalPath = PathUtils.join(p.capturesDir, `capture_pasted_${timestampId()}_${randHex(3)}.json`);
      await this._writeJSON(finalPath, finalCapture);
    }
    const fingerprint = this._fingerprintFromCapture(env, finalCapture, {
      type: "imported-capture",
      path: finalPath || null,
    });
    await this._writeJSON(p.fingerprintPath, fingerprint);
    const proxy = (await this._readOrCreateCurrentProcessConfig("proxy")).config;
    await this._upsertCurrentProfileUserJs(fingerprint, proxy);
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

  async resetCurrentProcessDefault({ confirm = false } = {}) {
    if (confirm !== true) {
      throw new Error("confirm:true required to reset current process fingerprint defaults");
    }
    await this._ensureRoot();
    const p = this._currentProcessPaths();
    await this._removeCurrentProfileUserJsBlock();
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

  async current({ refresh = true } = {}) {
    await this._ensureRoot();
    const id = this._currentEnvId();
    if (!id) {
      return { ok: true, id: null, environment: null, root: this._root };
    }
    try {
      const env = refresh === false ? await this._loadEnv(id) : await this._refreshRuntime(await this._loadEnv(id));
      return { ok: true, id, environment: shortEnv(env), root: this._root };
    } catch (e) {
      return {
        ok: false,
        id,
        environment: null,
        root: this._root,
        error: e && e.message ? e.message : String(e),
      };
    }
  }

  async _loadEnv(id) {
    this._validateId(id);
    await this._ensureRoot();
    const env = await this._readJSON(this._paths(id).envPath, null);
    if (!env || env.id !== id) {
      throw new Error("environment not found: " + id);
    }
    env.runtime = env.runtime || { status: "stopped", pid: null };
    return env;
  }

  async update({ id, name } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    if (name != null) {
      const n = String(name).trim();
      if (!n) {
        throw new Error("name cannot be empty");
      }
      env.name = n;
    }
    env.processLabel = processLabelFor(env);
    env.runtime = {
      ...(env.runtime || {}),
      processLabel: env.processLabel,
    };
    await this._saveEnv(env);
    await this._writeProfilePrefs(env, env.runtime?.marionettePort || null);
    return { ok: true, environment: shortEnv(env) };
  }

  async _refreshRuntime(env) {
    const rt = env.runtime || {};
    if ((rt.status === "running" || rt.status === "starting") && rt.pid && !(await this._pidAlive(rt.pid))) {
      env.runtime = {
        ...rt,
        status: "stopped",
        pid: null,
        lastStoppedAt: nowISO(),
        stopReason: "process-not-found",
      };
      await this._saveRuntime(env);
    }
    return env;
  }

  async list({ refresh = true } = {}) {
    const manifest = await this._loadManifest();
    const out = [];
    for (const item of manifest.environments || []) {
      try {
        let env = await this._loadEnv(item.id);
        if (refresh) {
          env = await this._refreshRuntime(env);
        }
        out.push(shortEnv(env));
      } catch {
        out.push(item);
      }
    }
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { ok: true, root: this._root, count: out.length, environments: out };
  }

  async status({ id } = {}) {
    if (id) {
      const env = await this._refreshRuntime(await this._loadEnv(String(id)));
      return { ok: true, environment: shortEnv(env) };
    }
    return this.list({ refresh: true });
  }

  _currentMarionettePort() {
    return safe(() => Services.prefs.getIntPref("marionette.port", DEFAULT_PORT_BASE), DEFAULT_PORT_BASE);
  }

  async _usedPorts(exceptId = null) {
    const manifest = await this._loadManifest();
    const used = new Set([this._currentMarionettePort()]);
    for (const item of manifest.environments || []) {
      if (item.id === exceptId) {
        continue;
      }
      const rt = item.runtime || {};
      if ((rt.status === "running" || rt.status === "starting") && rt.marionettePort) {
        used.add(Number(rt.marionettePort));
      }
    }
    return used;
  }

  async _allocatePort(env, requestedPort = null) {
    const used = await this._usedPorts(env.id);
    const current = requestedPort || env.runtime?.marionettePort || null;
    if (current && !used.has(Number(current))) {
      return Number(current);
    }
    const base = DEFAULT_PORT_BASE;
    for (let i = 0; i < MAX_PORT_SCAN; i++) {
      const port = base + i;
      if (!used.has(port)) {
        return port;
      }
    }
    throw new Error("no free Marionette port found");
  }

  _getFirefoxBin() {
    if (this._firefoxBin) {
      return this._firefoxBin;
    }
    const exe = safe(() => Services.dirsvc.get("XREExeF", Ci.nsIFile).path, "");
    if (exe) {
      return exe;
    }
    const gre = safe(() => Services.dirsvc.get("GreBinD", Ci.nsIFile).path, "");
    if (gre) {
      const name = safe(() => Services.appinfo.OS === "WINNT", false) ? "firefox.exe" : "firefox";
      return PathUtils.join(gre, name);
    }
    throw new Error("cannot locate current Firefox executable");
  }

  _processArgv0(env, port = null) {
    return String(processSlotLabel(port) || processLabelFor(env) || env.id || "Firefox Reverse")
      .replace(/[\u0000/]+/g, " ")
      .trim()
      .slice(0, 80) || env.id;
  }

  _launchSpec(env, bin, args, port = null) {
    const os = safe(() => Services.appinfo.OS, "");
    const argv0 = this._processArgv0(env, port);
    if (os === "Darwin") {
      return {
        command: "/bin/zsh",
        arguments: ["-lc", 'label="$1"; shift; exec -a "$label" "$@"', "frx-env-launch", argv0, bin, ...args],
        originalCommand: bin,
        originalArgs: args,
        argv0,
      };
    }
    return {
      command: bin,
      arguments: args,
      originalCommand: bin,
      originalArgs: args,
      argv0,
    };
  }

  async _saveRuntime(env) {
    await this._writeJSON(this._paths(env.id).runtimePath, env.runtime || {});
    await this._saveEnv(env);
  }

  async open({ id, url, port, firefoxBin } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    let env = await this._refreshRuntime(await this._loadEnv(String(id)));
    if ((env.runtime.status === "running" || env.runtime.status === "starting" || env.runtime.status === "closing") && env.runtime.pid) {
      return { ok: true, alreadyRunning: true, environment: shortEnv(env) };
    }
    const marionettePort = await this._allocatePort(env, port);
    const bin = firefoxBin || this._getFirefoxBin();
    const runtimeConfig = await this._syncProfileRuntimeConfig(env);
    await this._writeProfilePrefs(env, marionettePort, runtimeConfig);
    const p = this._paths(env.id);
    const args = [
      "-marionette",
      "-remote-allow-system-access",
      "-no-remote",
      "-profile",
      env.profilePath,
    ];
    const finalUrl = String(url || "").trim();
    if (finalUrl) {
      args.push(finalUrl);
    }
    const launch = this._launchSpec(env, bin, args, marionettePort);
    env.runtime = {
      ...env.runtime,
      status: "starting",
      pid: null,
      marionettePort,
      lastStartedAt: nowISO(),
      lastUrl: finalUrl || null,
      firefoxBin: bin,
      envName: envDisplayName(env),
      processLabel: launch.argv0,
      processArgv0: launch.argv0,
    };
    await this._saveRuntime(env);
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (!Subprocess) {
      throw new Error("Subprocess unavailable");
    }
    const childEnv = {
      MOZ_FRX_ENV_ID: env.id,
      MOZ_FRX_ENV_NAME: envDisplayName(env),
      MOZ_FRX_PROCESS_LABEL: launch.argv0,
      MOZ_FRX_ENVS_ROOT: this._root,
      MOZ_FRX_FINGERPRINT_CONFIG: runtimeConfig.fingerprintPath,
      MOZ_FRX_FINGERPRINT_JSON: JSON.stringify(runtimeConfig.fingerprint),
      MOZ_FRX_PROXY_CONFIG: runtimeConfig.proxyPath,
      MOZ_FRX_PROXY_JSON: JSON.stringify(runtimeConfig.proxy),
      MOZ_FRX_TRACE_DIR: env.traceDir,
      MOZ_FRX_CONTROL_DIR: env.controlDir,
      MOZ_WEBAPI_TRACE_FILE: PathUtils.join(env.traceDir, "webapi.ndjson"),
      MOZ_WEBAPI_TRACE_CTL: PathUtils.join(env.controlDir, "webapi.ctl"),
      MOZ_JSVMP_TRACE_FILE: PathUtils.join(env.traceDir, "jsvmp.ndjson"),
      MOZ_FRX_HIDE_REMOTE_CONTROL_CUE: "1",
      FRX_ENV_ID: env.id,
      FRX_ENV_NAME: envDisplayName(env),
      FRX_ENVS_ROOT: this._root,
    };
    let proc;
    try {
      proc = await Subprocess.call({
        command: launch.command,
        arguments: launch.arguments,
        environment: childEnv,
        environmentAppend: true,
        stderr: "stdout",
      });
    } catch (e) {
      env.runtime = {
        ...env.runtime,
        status: "stopped",
        pid: null,
        lastStoppedAt: nowISO(),
        startError: e && e.message ? e.message : String(e),
      };
      await this._saveRuntime(env);
      throw e;
    }
    this._procs.set(env.id, proc);
    env.runtime = {
      ...env.runtime,
      status: "running",
      pid: proc && proc.pid ? proc.pid : null,
      marionettePort,
      lastStartedAt: env.runtime.lastStartedAt,
      lastUrl: finalUrl || null,
      firefoxBin: bin,
      envName: envDisplayName(env),
      processLabel: launch.argv0,
      processArgv0: launch.argv0,
    };
    await this._saveRuntime(env);
    return {
      ok: true,
      launched: true,
      command: launch.command,
      args: launch.arguments,
      originalCommand: launch.originalCommand,
      originalArgs: launch.originalArgs,
      argv0: launch.argv0,
      launchEnvironment: childEnv,
      environment: shortEnv(env),
    };
  }

  async close({ id } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    const pid = env.runtime?.pid || null;
    env.runtime = {
      ...(env.runtime || {}),
      status: "closing",
      lastClosingAt: nowISO(),
    };
    await this._saveRuntime(env);
    const proc = this._procs.get(env.id);
    let forced = false;
    if (proc && proc.kill) {
      try {
        proc.kill();
        if (proc.wait) {
          await Promise.race([proc.wait(), delay(15000)]);
        }
      } catch {
        /* process may already be gone */
      }
      const procPid = pid || proc.pid || null;
      if (procPid && (await this._pidAlive(procPid))) {
        forced = await this._killPid(procPid, { force: true });
      }
      this._procs.delete(env.id);
    } else if (pid) {
      const res = await this._terminatePid(pid);
      forced = res.forced;
    }
    env.runtime = {
      ...(env.runtime || {}),
      status: "stopped",
      pid: null,
      lastStoppedAt: nowISO(),
      stopReason: forced ? "forced-kill-after-timeout" : "closed",
    };
    await this._saveRuntime(env);
    return { ok: true, environment: shortEnv(env) };
  }

  async delete({ id, confirm = false } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    if (confirm !== true) {
      throw new Error("confirm:true required to delete an environment");
    }
    const env = await this._refreshRuntime(await this._loadEnv(String(id)));
    if (env.runtime?.status === "running" || env.runtime?.status === "starting" || env.runtime?.status === "closing") {
      throw new Error("environment is running; close it before delete");
    }
    await IOUtils.remove(env.rootPath, { recursive: true, ignoreAbsent: true });
    await this._removeFromManifest(env.id);
    this._procs.delete(env.id);
    return { ok: true, deleted: env.id };
  }

  _configPath(env, type) {
    const t = String(type || "fingerprint").toLowerCase();
    if (t === "fingerprint") {
      return env.fingerprintPath;
    }
    if (t === "proxy") {
      return env.proxyPath;
    }
    throw new Error("unsupported config type: " + type);
  }

  async readConfig({ id, type = "fingerprint" } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    const path = this._configPath(env, type);
    const config = await this._readJSON(path, null);
    if (!config || typeof config !== "object") {
      throw new Error(`cannot read ${type} config for environment ${id}`);
    }
    return { ok: true, id: env.id, type, path, config };
  }

  async writeConfig({ id, type = "fingerprint", config, text } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("config must be a JSON object");
    }
    if (!data.schemaVersion) {
      data.schemaVersion = SCHEMA_VERSION;
    }
    data.updatedAt = nowISO();
    const path = this._configPath(env, type);
    await this._writeJSON(path, data);
    env.updatedAt = nowISO();
    await this._saveEnv(env);
    return { ok: true, id: env.id, type, path, config: data, environment: shortEnv(env) };
  }

  _importPayload({ text, config } = {}) {
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("environment import JSON must be an object");
    }
    const envMeta =
      data.env && typeof data.env === "object" && !Array.isArray(data.env)
        ? data.env
        : data.environment && typeof data.environment === "object" && !Array.isArray(data.environment)
          ? data.environment
          : {};
    const fingerprint =
      data.fingerprint && typeof data.fingerprint === "object" && !Array.isArray(data.fingerprint)
        ? data.fingerprint
        : data.fingerprintJson && typeof data.fingerprintJson === "object" && !Array.isArray(data.fingerprintJson)
          ? data.fingerprintJson
          : null;
    const proxy =
      data.proxy && typeof data.proxy === "object" && !Array.isArray(data.proxy)
        ? data.proxy
        : data.proxyJson && typeof data.proxyJson === "object" && !Array.isArray(data.proxyJson)
          ? data.proxyJson
          : null;
    const generateOptions =
      data.generateOptions && typeof data.generateOptions === "object" && !Array.isArray(data.generateOptions)
        ? data.generateOptions
        : null;
    return { data, envMeta, fingerprint, proxy, generateOptions };
  }

  async importEnvironment({ id, name, text, config, overwrite = false } = {}) {
    await this._ensureRoot();
    const payload = this._importPayload({ text, config });
    const finalName = String(name || payload.data.name || payload.envMeta.name || "Imported Environment").trim();
    const rawId = id || payload.data.id || payload.envMeta.id || "";
    const envId = rawId ? String(rawId).trim() : this._newId(finalName);
    this._validateId(envId);
    const p = this._paths(envId);
    const exists = await IOUtils.exists(p.envPath);
    if (exists && overwrite !== true) {
      throw new Error("environment already exists; pass overwrite:true to replace its configs");
    }

    let env;
    if (!exists) {
      await this.create({
        id: envId,
        name: finalName,
        generateOptions: payload.generateOptions || { randomize: true, browser: payload.data.browser || payload.data.browserFamily || "chromium" },
      });
      env = await this._loadEnv(envId);
    } else {
      env = await this._loadEnv(envId);
      if (finalName) {
        env.name = finalName;
      }
    }

    const ts = nowISO();
    if (payload.fingerprint) {
      payload.fingerprint.schemaVersion = payload.fingerprint.schemaVersion || SCHEMA_VERSION;
      payload.fingerprint.updatedAt = ts;
      await this._writeJSON(env.fingerprintPath, payload.fingerprint);
      env.browserFamily = payload.fingerprint.source?.browser || payload.fingerprint.source?.normalizedBrowser || env.browserFamily || "chromium";
    }
    if (payload.proxy) {
      payload.proxy.schemaVersion = payload.proxy.schemaVersion || SCHEMA_VERSION;
      payload.proxy.updatedAt = ts;
      await this._writeJSON(env.proxyPath, payload.proxy);
    }
    env.updatedAt = ts;
    env.source = {
      ...(env.source || {}),
      type: "imported",
      importedAt: ts,
      hasFingerprint: !!payload.fingerprint,
      hasProxy: !!payload.proxy,
    };
    await this._saveEnv(env);
    const running = isRuntimeActive(env.runtime);
    return {
      ok: true,
      id: env.id,
      imported: true,
      created: !exists,
      overwritten: exists && overwrite === true,
      needsRestart: running,
      environment: shortEnv(env),
      fingerprintPath: env.fingerprintPath,
      proxyPath: env.proxyPath,
    };
  }

  async generateFingerprint({ id, options = {} } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    const fingerprint = this._buildFingerprint(env, options, { type: "generated" });
    await this._writeJSON(env.fingerprintPath, fingerprint);
    env.browserFamily = fingerprint.source?.browser || normalizeBrowserFamily(options.browser || options.browserFamily, env.browserFamily || "firefox");
    env.source = { type: "generated", browser: env.browserFamily, updatedAt: nowISO(), options };
    await this._saveEnv(env);
    return { ok: true, id: env.id, path: env.fingerprintPath, fingerprint, environment: shortEnv(env) };
  }

  _captureCanvasJS() {
    return safe(() => {
      const doc = globalThis.document;
      if (!doc || !doc.createElement) {
        return null;
      }
      const canvas = doc.createElement("canvas");
      canvas.width = 240;
      canvas.height = 80;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return null;
      }
      ctx.fillStyle = "#f7f7f7";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1b1b1b";
      ctx.font = "18px Arial";
      ctx.fillText("Firefox Reverse 13.7", 8, 28);
      ctx.fillStyle = "rgba(24, 119, 242, 0.55)";
      ctx.beginPath();
      ctx.arc(64, 52, 18, 0, Math.PI * 2);
      ctx.fill();
      const dataURL = canvas.toDataURL("image/png");
      return {
        hash: hashString32(dataURL),
        dataUrlLength: dataURL.length,
      };
    }, null);
  }

  _captureWebGLJS() {
    return safe(() => {
      const doc = globalThis.document;
      if (!doc || !doc.createElement) {
        return null;
      }
      const canvas = doc.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) {
        return null;
      }
      const ext = safe(() => gl.getExtension("WEBGL_debug_renderer_info"), null);
      const aniso = safe(
        () =>
          gl.getExtension("EXT_texture_filter_anisotropic") ||
          gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") ||
          gl.getExtension("MOZ_EXT_texture_filter_anisotropic"),
        null
      );
      return {
        vendor: safe(() => gl.getParameter(gl.VENDOR), ""),
        renderer: safe(() => gl.getParameter(gl.RENDERER), ""),
        version: safe(() => gl.getParameter(gl.VERSION), ""),
        shadingLanguageVersion: safe(() => gl.getParameter(gl.SHADING_LANGUAGE_VERSION), ""),
        unmaskedVendor: ext ? safe(() => gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), "") : "",
        unmaskedRenderer: ext ? safe(() => gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), "") : "",
        antialias: safe(() => gl.getContextAttributes().antialias, null),
        redBits: safe(() => gl.getParameter(gl.RED_BITS), null),
        greenBits: safe(() => gl.getParameter(gl.GREEN_BITS), null),
        blueBits: safe(() => gl.getParameter(gl.BLUE_BITS), null),
        alphaBits: safe(() => gl.getParameter(gl.ALPHA_BITS), null),
        depthBits: safe(() => gl.getParameter(gl.DEPTH_BITS), null),
        stencilBits: safe(() => gl.getParameter(gl.STENCIL_BITS), null),
        maxAnisotropy: aniso ? safe(() => gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT), null) : null,
        maxTextureSize: safe(() => gl.getParameter(gl.MAX_TEXTURE_SIZE), null),
        maxViewportDims: safe(() => Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []), []),
        aliasedLineWidthRange: safe(() => Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []), []),
        aliasedPointSizeRange: safe(() => Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []), []),
        maxCombinedTextureImageUnits: safe(() => gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS), null),
        maxCubeMapTextureSize: safe(() => gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE), null),
        maxFragmentUniformVectors: safe(() => gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS), null),
        maxRenderbufferSize: safe(() => gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), null),
        maxTextureImageUnits: safe(() => gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), null),
        maxVaryingVectors: safe(() => gl.getParameter(gl.MAX_VARYING_VECTORS), null),
        maxVertexAttribs: safe(() => gl.getParameter(gl.MAX_VERTEX_ATTRIBS), null),
        maxVertexTextureImageUnits: safe(() => gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), null),
        maxVertexUniformVectors: safe(() => gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS), null),
        extensions: safe(() => gl.getSupportedExtensions() || [], []),
      };
    }, null);
  }

  _captureAudioJS() {
    return safe(() => {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      const ctx = new Ctor();
      const out = {
        sampleRate: ctx.sampleRate || null,
        state: ctx.state || "",
        baseLatency: ctx.baseLatency || null,
        outputLatency: ctx.outputLatency || null,
      };
      safe(() => ctx.close(), null);
      return out;
    }, null);
  }

  _captureCurrentBrowserJS() {
    const nav = safe(() => globalThis.navigator, null);
    const scr = safe(() => globalThis.screen, null);
    const intl = safe(() => Intl.DateTimeFormat().resolvedOptions(), {});
    const languages = safe(() => Array.from(nav.languages || []), []);
    const webgl = this._captureWebGLJS();
    const canvas = this._captureCanvasJS();
    const audio = this._captureAudioJS();
    const listPlugins = () =>
      safe(
        () =>
          Array.from(nav.plugins || []).map(p => ({
            name: p.name || "",
            filename: p.filename || "",
            description: p.description || "",
            mimeTypes: Array.from(p || [])
              .map(m => m.type || "")
              .filter(Boolean),
          })),
        []
      );
    const listMimeTypes = () =>
      safe(
        () =>
          Array.from(nav.mimeTypes || []).map(m => ({
            type: m.type || "",
            suffixes: m.suffixes || "",
            description: m.description || "",
            enabledPlugin: m.enabledPlugin ? m.enabledPlugin.name || "" : "",
          })),
        []
      );
    const userAgentData = safe(() => {
      const uaData = nav.userAgentData;
      if (!uaData) {
        return null;
      }
      return {
        brands: Array.from(uaData.brands || []),
        mobile: uaData.mobile,
        platform: uaData.platform || "",
      };
    }, null);
    const brands = userAgentData && Array.isArray(userAgentData.brands) ? userAgentData.brands : [];
    return {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: nowISO(),
      source: {
        type: "current-browser-js",
        url: safe(() => globalThis.location.href, ""),
        note: "Captured from the currently running Firefox Reverse chrome JS environment.",
      },
      navigator: {
        userAgent: safe(() => nav.userAgent, ""),
        platform: safe(() => nav.platform, ""),
        language: safe(() => nav.language, ""),
        languages,
        webdriver: safe(() => nav.webdriver, null),
        hardwareConcurrency: safe(() => nav.hardwareConcurrency, null),
        appCodeName: safe(() => nav.appCodeName, ""),
        appName: safe(() => nav.appName, ""),
        appVersion: safe(() => nav.appVersion, ""),
        product: safe(() => nav.product, ""),
        productSub: safe(() => nav.productSub, ""),
        vendor: safe(() => nav.vendor, ""),
        vendorSub: safe(() => nav.vendorSub, ""),
        maxTouchPoints: safe(() => nav.maxTouchPoints, null),
        cookieEnabled: safe(() => nav.cookieEnabled, null),
        pdfViewerEnabled: safe(() => nav.pdfViewerEnabled, null),
        doNotTrack: safe(() => nav.doNotTrack, null),
        oscpu: safe(() => nav.oscpu, null),
        buildID: safe(() => nav.buildID, null),
        userAgentData,
        plugins: listPlugins(),
        mimeTypes: listMimeTypes(),
      },
      screen: {
        width: safe(() => scr.width, null),
        height: safe(() => scr.height, null),
        availWidth: safe(() => scr.availWidth, null),
        availHeight: safe(() => scr.availHeight, null),
        colorDepth: safe(() => scr.colorDepth, null),
        pixelDepth: safe(() => scr.pixelDepth, null),
        orientation: safe(() => (scr.orientation ? { type: scr.orientation.type || "", angle: scr.orientation.angle || 0 } : null), null),
      },
      window: {
        devicePixelRatio: safe(() => globalThis.devicePixelRatio, null),
        innerWidth: safe(() => globalThis.innerWidth, null),
        innerHeight: safe(() => globalThis.innerHeight, null),
        outerWidth: safe(() => globalThis.outerWidth, null),
        outerHeight: safe(() => globalThis.outerHeight, null),
      },
      intl: {
        locale: intl && intl.locale ? intl.locale : safe(() => nav.language, ""),
        timezone: intl && intl.timeZone ? intl.timeZone : "",
        calendar: intl && intl.calendar ? intl.calendar : "",
        numberingSystem: intl && intl.numberingSystem ? intl.numberingSystem : "",
        timezoneOffset: safe(() => new Date().getTimezoneOffset(), null),
      },
      http: {
        userAgent: safe(() => nav.userAgent, ""),
        acceptLanguage: acceptLanguageFrom(languages),
        secChUa: secChUaFromBrands(brands),
        secChUaMobile: userAgentData ? (userAgentData.mobile ? "?1" : "?0") : "",
        secChUaPlatform: userAgentData && userAgentData.platform ? `"${String(userAgentData.platform).replaceAll('"', '\\"')}"` : "",
      },
      webgl,
      canvas,
      audio,
      fonts: {
        queryLocalFonts: safe(() => typeof globalThis.queryLocalFonts === "function", false),
      },
      storage: {
        localStorage: safe(() => typeof globalThis.localStorage === "object", false),
        sessionStorage: safe(() => typeof globalThis.sessionStorage === "object", false),
        indexedDB: safe(() => typeof globalThis.indexedDB === "object", false),
        cookie: safe(() => globalThis.document.cookie || "", ""),
      },
    };
  }

  async captureFingerprint({ id } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
    const capture = this._captureCurrentBrowserJS();
    const p = this._paths(env.id);
    await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
    const capturePath = PathUtils.join(p.capturesDir, `capture_${timestampId()}_${randHex(3)}.json`);
    await this._writeJSON(capturePath, capture);
    return { ok: true, id: env.id, path: capturePath, capture };
  }

  _fingerprintFromCapture(env, capture, source = {}) {
    const nav = capture && capture.navigator ? capture.navigator : {};
    const scr = capture && capture.screen ? capture.screen : {};
    const win = capture && capture.window ? capture.window : {};
    const intl = capture && capture.intl ? capture.intl : {};
    const http = capture && capture.http ? capture.http : {};
    const webgl = capture && capture.webgl ? capture.webgl : {};
    const canvas = capture && capture.canvas ? capture.canvas : {};
    const audio = capture && capture.audio ? capture.audio : {};
    const storage = capture && capture.storage ? capture.storage : {};
    const capturedUA = unwrapField(nav.userAgent, unwrapField(http.userAgent, ""));
    const capturedBrowser = browserFamilyFromUA(capturedUA);
    const targetBrowser = capturedBrowser === "chromium" ? "chromium" : "firefox";
    const firefoxCompatible = targetBrowser === "firefox" && capturedBrowser === "firefox";
    const defaults = this._detectDefaults();
    const importedOS = osFromUA(capturedUA, defaults.os);
    const firefoxVersion = normalizeVersion(safe(() => Services.appinfo.version, ""), "128.0");
    const chromeVersion = chromeVersionFromUA(capturedUA, `${majorVersion(firefoxVersion, 128)}.0.0.0`);
    const firefoxUA = this._uaParts({ os: importedOS, firefoxVersion });
    const chromeUA = this._uaParts({ os: importedOS, browser: "chromium", chromeVersion });
    const targetUA = targetBrowser === "chromium" ? chromeUA : firefoxUA;
    return this._buildFingerprint(
      env,
      {
        enabled: true,
        browser: targetBrowser,
        os: importedOS,
        firefoxVersion,
        chromeVersion,
        userAgent: targetBrowser === "chromium" ? capturedUA || chromeUA.userAgent : firefoxCompatible ? capturedUA : firefoxUA.userAgent,
        platform: unwrapField(nav.platform, targetUA.platform),
        language: unwrapField(nav.language, unwrapField(intl.locale, "en-US")),
        languages: unwrapField(nav.languages, null),
        navigator: {
          appCodeName: unwrapField(nav.appCodeName, "Mozilla"),
          appName: unwrapField(nav.appName, "Netscape"),
          appVersion: unwrapField(nav.appVersion, ""),
          product: unwrapField(nav.product, "Gecko"),
          productSub: unwrapField(nav.productSub, "20100101"),
          vendor: targetBrowser === "chromium" ? unwrapField(nav.vendor, "Google Inc.") : firefoxCompatible ? unwrapField(nav.vendor, "") : "",
          vendorSub: unwrapField(nav.vendorSub, ""),
          maxTouchPoints: unwrapField(nav.maxTouchPoints, null),
          cookieEnabled: unwrapField(nav.cookieEnabled, true),
          pdfViewerEnabled: unwrapField(nav.pdfViewerEnabled, true),
          doNotTrack: unwrapField(nav.doNotTrack, null),
          oscpu: firefoxCompatible ? unwrapField(nav.oscpu, null) : null,
          buildID: firefoxCompatible ? unwrapField(nav.buildID, null) : null,
          userAgentData: targetBrowser === "chromium" ? unwrapField(nav.userAgentData, null) : null,
          plugins: unwrapField(nav.plugins, []),
          mimeTypes: unwrapField(nav.mimeTypes, []),
        },
        resolution: {
          width: unwrapField(scr.width, 1920),
          height: unwrapField(scr.height, 1080),
        },
        screen: {
          orientation: unwrapField(scr.orientation, null),
        },
        availWidth: unwrapField(scr.availWidth, unwrapField(scr.width, 1920)),
        availHeight: unwrapField(scr.availHeight, unwrapField(scr.height, 1080)),
        colorDepth: unwrapField(scr.colorDepth, 24),
        pixelDepth: unwrapField(scr.pixelDepth, 24),
        devicePixelRatio: unwrapField(win.devicePixelRatio, 1),
        window: {
          innerWidth: unwrapField(win.innerWidth, null),
          innerHeight: unwrapField(win.innerHeight, null),
          outerWidth: unwrapField(win.outerWidth, null),
          outerHeight: unwrapField(win.outerHeight, null),
        },
        hardwareConcurrency: unwrapField(nav.hardwareConcurrency, 8),
        timezone: unwrapField(intl.timezone, unwrapField(intl.timeZone, "UTC")),
        locale: unwrapField(intl.locale, unwrapField(nav.language, "en-US")),
        intl: {
          calendar: unwrapField(intl.calendar, ""),
          numberingSystem: unwrapField(intl.numberingSystem, ""),
          timezoneOffset: unwrapField(intl.timezoneOffset, null),
        },
        acceptLanguage: unwrapField(http.acceptLanguage, null),
        http: {
          secChUa: unwrapField(http.secChUa, null),
          secChUaMobile: unwrapField(http.secChUaMobile, null),
          secChUaPlatform: unwrapField(http.secChUaPlatform, null),
          secChUaFullVersionList: unwrapField(http.secChUaFullVersionList, null),
          secChUaArch: unwrapField(http.secChUaArch, null),
          secChUaBitness: unwrapField(http.secChUaBitness, null),
          secChUaModel: unwrapField(http.secChUaModel, null),
          secChUaPlatformVersion: unwrapField(http.secChUaPlatformVersion, null),
        },
        webgl: {
          vendor: unwrapField(webgl.vendor, ""),
          renderer: unwrapField(webgl.renderer, ""),
          unmaskedVendor: unwrapField(webgl.unmaskedVendor, ""),
          unmaskedRenderer: unwrapField(webgl.unmaskedRenderer, ""),
          antialias: unwrapField(webgl.antialias, null),
          redBits: unwrapField(webgl.redBits, null),
          greenBits: unwrapField(webgl.greenBits, null),
          blueBits: unwrapField(webgl.blueBits, null),
          alphaBits: unwrapField(webgl.alphaBits, null),
          depthBits: unwrapField(webgl.depthBits, null),
          stencilBits: unwrapField(webgl.stencilBits, null),
          maxAnisotropy: unwrapField(webgl.maxAnisotropy, null),
          maxTextureSize: unwrapField(webgl.maxTextureSize, null),
          maxViewportDims: unwrapField(webgl.maxViewportDims, null),
          aliasedLineWidthRange: unwrapField(webgl.aliasedLineWidthRange, null),
          aliasedPointSizeRange: unwrapField(webgl.aliasedPointSizeRange, null),
          maxCombinedTextureImageUnits: unwrapField(webgl.maxCombinedTextureImageUnits, null),
          maxCubeMapTextureSize: unwrapField(webgl.maxCubeMapTextureSize, null),
          maxFragmentUniformVectors: unwrapField(webgl.maxFragmentUniformVectors, null),
          maxRenderbufferSize: unwrapField(webgl.maxRenderbufferSize, null),
          maxTextureImageUnits: unwrapField(webgl.maxTextureImageUnits, null),
          maxVaryingVectors: unwrapField(webgl.maxVaryingVectors, null),
          maxVertexAttribs: unwrapField(webgl.maxVertexAttribs, null),
          maxVertexTextureImageUnits: unwrapField(webgl.maxVertexTextureImageUnits, null),
          maxVertexUniformVectors: unwrapField(webgl.maxVertexUniformVectors, null),
          extensions: unwrapField(webgl.extensions, null),
        },
        canvas: {
          mode: "native",
          hash: unwrapField(canvas.hash, ""),
          dataUrlLength: unwrapField(canvas.dataUrlLength, null),
        },
        audio: {
          sampleRate: unwrapField(audio.sampleRate, 48000),
          baseLatency: unwrapField(audio.baseLatency, null),
          outputLatency: unwrapField(audio.outputLatency, null),
        },
        storage: {
          localStorage: unwrapField(storage.localStorage, true),
          sessionStorage: unwrapField(storage.sessionStorage, true),
          indexedDB: unwrapField(storage.indexedDB, true),
          cookie: unwrapField(storage.cookie, null),
        },
      },
      {
        ...source,
        capturedBrowser,
        normalizedBrowser: targetBrowser,
        normalizedFromNonFirefox: capturedBrowser !== targetBrowser,
      }
    );
  }

  async _latestCapturePath(env) {
    const p = this._paths(env.id);
    let children = [];
    try {
      children = await IOUtils.getChildren(p.capturesDir);
    } catch {
      return "";
    }
    const captures = (children || []).filter(x => String(x).endsWith(".json")).sort();
    return captures.length ? captures[captures.length - 1] : "";
  }

  async importFingerprint({ id, capturePath, capture, text } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._loadEnv(String(id));
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
        finalPath = await this._latestCapturePath(env);
      } else if (!finalPath.includes("/") && !finalPath.includes("\\")) {
        finalPath = PathUtils.join(this._paths(env.id).capturesDir, finalPath);
      }
      if (!finalPath) {
        throw new Error("no capture found to import");
      }
      finalCapture = await this._readJSON(finalPath, null);
    }
    if (!finalCapture || typeof finalCapture !== "object") {
      throw new Error("capture must be a JSON object");
    }
    if (!finalPath) {
      const p = this._paths(env.id);
      await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
      finalPath = PathUtils.join(p.capturesDir, `capture_pasted_${timestampId()}_${randHex(3)}.json`);
      await this._writeJSON(finalPath, finalCapture);
    }
    const fingerprint = this._fingerprintFromCapture(env, finalCapture, {
      type: "imported-capture",
      path: finalPath || null,
    });
    await this._writeJSON(env.fingerprintPath, fingerprint);
    env.browserFamily = fingerprint.source?.browser || fingerprint.source?.normalizedBrowser || env.browserFamily || "firefox";
    env.source = {
      type: "imported-capture",
      browser: env.browserFamily,
      updatedAt: nowISO(),
      capturePath: finalPath || null,
      capturedBrowser: fingerprint.source?.capturedBrowser || null,
      normalizedBrowser: fingerprint.source?.normalizedBrowser || null,
      normalizedFromNonFirefox: fingerprint.source?.normalizedFromNonFirefox === true,
    };
    await this._saveEnv(env);
    return { ok: true, id: env.id, path: env.fingerprintPath, capturePath: finalPath || null, fingerprint, environment: shortEnv(env) };
  }

  async _pidAlive(pid) {
    if (!pid) {
      return false;
    }
    const os = safe(() => Services.appinfo.OS, "");
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (!Subprocess) {
      return true;
    }
    try {
      let proc;
      if (os === "WINNT") {
        proc = await Subprocess.call({
          command: "tasklist.exe",
          arguments: ["/FI", "PID eq " + String(pid)],
          stderr: "stdout",
        });
        const out = await proc.stdout.readString();
        const r = await proc.wait();
        return r.exitCode === 0 && out.includes(String(pid));
      }
      proc = await Subprocess.call({
        command: "/bin/kill",
        arguments: ["-0", String(pid)],
        stderr: "stdout",
      });
      const r = await proc.wait();
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  async _terminatePid(pid) {
    if (!pid) {
      return { ok: false, forced: false };
    }
    await this._killPid(pid, { force: false });
    for (let i = 0; i < 60; i++) {
      if (!(await this._pidAlive(pid))) {
        return { ok: true, forced: false };
      }
      await delay(250);
    }
    const forced = await this._killPid(pid, { force: true });
    for (let i = 0; i < 20; i++) {
      if (!(await this._pidAlive(pid))) {
        return { ok: true, forced };
      }
      await delay(250);
    }
    return { ok: false, forced };
  }

  async _killPid(pid, { force = false } = {}) {
    const os = safe(() => Services.appinfo.OS, "");
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (!Subprocess || !pid) {
      return false;
    }
    try {
      const proc = await Subprocess.call(
        os === "WINNT"
          ? { command: "taskkill.exe", arguments: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], stderr: "stdout" }
          : { command: "/bin/kill", arguments: [force ? "-KILL" : "-TERM", String(pid)], stderr: "stdout" }
      );
      await proc.wait();
      return true;
    } catch {
      return false;
    }
  }
}
