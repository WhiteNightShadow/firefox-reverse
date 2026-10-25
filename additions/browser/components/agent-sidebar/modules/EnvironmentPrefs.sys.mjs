/* EnvironmentPrefs.sys.mjs — 把指纹和代理配置翻译成 Firefox pref：环境 profile 的 user.js，以及主浏览器
 * user.js 里由我们托管的那一段。只生成文本，写文件由调用方负责。 */

import { NATIVE_CONSISTENCY_MODE, isNativeFingerprint, nativeRenderingPrefs } from "./NativeFingerprintPolicy.sys.mjs";
import {
  SCHEMA_VERSION,
  clampInt,
  configBool,
  configInt,
  configString,
  envDisplayName,
  field,
  processLabelFor,
  processSlotLabel,
  safe,
} from "./EnvironmentCommon.sys.mjs";

export const USERJS_BLOCK_START = "// >>> Firefox Reverse current-process fingerprint prefs";
export const USERJS_BLOCK_END = "// <<< Firefox Reverse current-process fingerprint prefs";
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
// Firefox 153 出厂值；运行时优先读默认分支，读不到才用这里的值。
const FIREFOX_TLS_DEFAULTS = {
  "security.tls.version.min": 3,
  "security.tls.version.max": 4,
  "network.http.http3.enable": true,
  "network.http.http3.enable_0rtt": true,
  "security.tls.enable_0rtt_data": true,
  "security.ssl.enable_alpn": true,
  "security.tls.ech.grease_probability": 100,
  "security.tls.ech.grease_http3": true,
  "security.tls.grease_http3_enable": false,
  "security.tls.enable_kyber": true,
};

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

export function defaultProxy() {
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

export function fingerprintUserPrefs(fingerprint = {}, resetNative = false) {
  const lines = [];
  const native = isNativeFingerprint(fingerprint);
  if (native || resetNative) {
    const renderingConfig = native ? fingerprint : { enabled: false, consistency: { mode: NATIVE_CONSISTENCY_MODE, version: 1 } };
    const defaults = {};
    const branch = safe(() => Services.prefs.getDefaultBranch(""), null);
    for (const [key, value] of Object.entries(nativeRenderingPrefs(renderingConfig))) {
      defaults[key] = safe(() => typeof value === "boolean" ? branch.getBoolPref(key) : typeof value === "number" ? branch.getIntPref(key) : branch.getStringPref(key), value);
    }
    for (const [key, value] of Object.entries(nativeRenderingPrefs(renderingConfig, defaults))) pushUserPref(lines, key, value);
    // 原生一致：TLS/QUIC 握手保持 Firefox 出厂值，否则和 Firefox UA 对不上。写复位值而不是不写：
    // 旧版本写进 prefs.js 的偏离值（关 0-RTT、开 QUIC GREASE）只删 user.js 行不会失效。
    for (const [key, fallback] of Object.entries(FIREFOX_TLS_DEFAULTS)) {
      pushUserPref(lines, key, safe(() => (typeof fallback === "boolean" ? branch.getBoolPref(key) : branch.getIntPref(key)), fallback));
    }
  }
  if (!fingerprint || fingerprint.enabled === false) {
    return lines;
  }

  const webgl = fingerprint.webgl || {};
  if (!native && webgl.enabled !== false) {
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
  if (!native && audio.enabled !== false) {
    const sampleRate = configInt(audio, "sampleRate", 8000, 192000, 0);
    if (sampleRate) {
      pushUserPref(lines, "media.cubeb.force_sample_rate", sampleRate);
    }
  }

  const fonts = fingerprint.fonts || {};
  if (!native && fonts.enabled !== false) {
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
  if (!native && tls.enabled !== false) {
    pushUserPref(lines, "security.tls.version.min", configInt(tls, "minVersion", 1, 4, 3));
    pushUserPref(lines, "security.tls.version.max", configInt(tls, "maxVersion", 1, 4, 4));
    pushUserPref(lines, "network.http.http3.enable", configBool(tls, "http3", true));
    pushUserPref(lines, "network.http.http3.enable_0rtt", configBool(tls, "zeroRtt", false));
    pushUserPref(lines, "security.tls.enable_0rtt_data", configBool(tls, "zeroRtt", false));
    pushUserPref(lines, "security.ssl.enable_alpn", configBool(tls, "alpn", true));
    pushUserPref(lines, "security.tls.ech.grease_probability", configInt(tls, "echGreaseProbability", 0, 100, 100));
    pushUserPref(lines, "security.tls.ech.grease_http3", configBool(tls, "echGrease", true));
    // QUIC 传输层 GREASE 与 ECH GREASE 是两回事，单独开关，默认同 Firefox（关）。
    pushUserPref(lines, "security.tls.grease_http3_enable", configBool(tls, "http3Grease", false));
    pushUserPref(lines, "security.tls.enable_kyber", configBool(tls, "kyber", true));
  }

  const protection = fingerprint.protection || {};
  if (Object.keys(protection).length) {
    pushUserPref(lines, "privacy.resistFingerprinting", configBool(protection, "resistFingerprinting", false));
    pushUserPref(lines, "privacy.fingerprintingProtection", configBool(protection, "fingerprintingProtection", false));
  }
  return lines;
}

export function proxyUserPrefs(proxy = {}, fingerprint = {}) {
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

// 环境总以 -marionette 启动：指纹覆盖关闭时 C++ 不接管 navigator.webdriver，会回落成 true 暴露自动化。
// 交给引擎的配置在关闭时只保留"隐藏 webdriver"，其余仍是原生——和 AUTOMATION_STEALTH_PREFS 一样属于自动化隐藏。
export function engineFingerprintFor(fingerprint) {
  return fingerprint && fingerprint.enabled === false
    ? { enabled: true, navigator: { webdriver: field(false) } }
    : fingerprint;
}

// paths 是该环境的目录布局（EnvironmentStore.paths(env.id)）；env 为空时只生成通用部分。
export function profileUserJs(env, paths, port = null, runtimeConfig = {}) {
  const p = env ? paths : null;
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
    const engineFingerprint = runtimeConfig.engineFingerprint || engineFingerprintFor(runtimeConfig.fingerprint);
    lines.push(`user_pref("frx.fingerprint.config.json", ${JSON.stringify(isNativeFingerprint(engineFingerprint) ? "" : JSON.stringify(engineFingerprint || {}))});`);
    lines.push(`user_pref("frx.proxy.config.path", ${JSON.stringify(p.runtimeProxyPath)});`);
    lines.push(`user_pref("frx.environment.id", ${JSON.stringify(env.id)});`);
    lines.push(`user_pref("frx.environment.name", ${JSON.stringify(envDisplayName(env))});`);
    lines.push(`user_pref("frx.process.label", ${JSON.stringify(port != null ? processSlotLabel(port) : processLabelFor(env))});`);
  }
  if (port != null) {
    lines.push(`user_pref("marionette.port", ${Number(port) | 0});`);
  }
  lines.push(...fingerprintUserPrefs(runtimeConfig.fingerprint || {}, env?.nativeRenderingManaged === true));
  lines.push(...proxyUserPrefs(runtimeConfig.proxy || {}, runtimeConfig.fingerprint || {}));
  return lines.join("\n") + "\n";
}

function managedBlockPattern() {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escape(USERJS_BLOCK_START)}[\\s\\S]*?${escape(USERJS_BLOCK_END)}\\n?`, "g");
}

// 主浏览器 user.js：换成新的托管块，同名的手写 pref 行一并去掉（以托管块为准）。返回新文本，以及上一版
// 托管块写过、这一版不再写的 pref（如旧版本无条件写入的 network.proxy.type=0）：user.js 删行不会撤销
// prefs.js 里已保存的值，调用方要显式清掉，回到默认值。
export function mergeManagedUserJs(oldText, prefLines) {
  const names = userPrefNames(prefLines);
  const dropped = new Set();
  for (const match of oldText.matchAll(managedBlockPattern())) {
    for (const name of userPrefNames(String(match[0]).split(/\r?\n/))) {
      if (!names.has(name)) {
        dropped.add(name);
      }
    }
  }
  const kept = oldText
    .replace(managedBlockPattern(), "")
    .split(/\r?\n/)
    .filter(line => {
      const m = String(line).match(/user_pref\("([^"]+)"/);
      return !m || !names.has(m[1]);
    })
    .join("\n")
    .replace(/\s+$/g, "");
  const block = [USERJS_BLOCK_START, ...prefLines, USERJS_BLOCK_END].join("\n");
  return { text: (kept ? kept + "\n\n" : "") + block + "\n", dropped };
}

// 去掉主浏览器 user.js 的托管块，以及其余位置上同名的 pref 行。返回新文本和应清掉运行值的 pref
// （alwaysClear 加上托管块里出现过的全部 pref）。
export function stripManagedUserJs(oldText, alwaysClear = []) {
  const names = new Set(alwaysClear);
  for (const match of oldText.matchAll(managedBlockPattern())) {
    for (const name of userPrefNames(String(match[0]).split(/\r?\n/))) {
      names.add(name);
    }
  }
  const next = oldText
    .replace(managedBlockPattern(), "")
    .split(/\r?\n/)
    .filter(line => {
      const m = String(line).match(/user_pref\("([^"]+)"/);
      return !m || !names.has(m[1]);
    })
    .join("\n")
    .replace(/\s+$/g, "");
  return { text: next ? next + "\n" : "", names };
}
