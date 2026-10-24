/* EnvironmentFingerprint.sys.mjs — 环境指纹：探测本机默认值、按选项生成指纹配置并校验、从当前浏览器
 * 采集，以及把采集结果规整成 Firefox 指纹。都是纯函数，不读写文件。 */

import { NATIVE_CONSISTENCY_MODE, isNativeFingerprint, nativeFingerprintDefaults, validateNativeFingerprint } from "./NativeFingerprintPolicy.sys.mjs";
import {
  SCHEMA_VERSION,
  clampInt,
  clampNumber,
  configArray,
  configBool,
  configField,
  configInt,
  configJSON,
  configNumber,
  configString,
  field,
  nowISO,
  randHex,
  safe,
  unwrapField,
} from "./EnvironmentCommon.sys.mjs";

const DEFAULT_ENV_REGION = "cn";

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

export function browserFamilyFromFingerprint(fingerprint) {
  const userAgents = [
    unwrapField(fingerprint?.navigator?.userAgent, ""),
    unwrapField(fingerprint?.http?.userAgent, ""),
  ].filter(Boolean);
  const userAgentFamilies = userAgents.map(browserFamilyFromUA);
  const nonFirefoxFamily = userAgentFamilies.find(family => family !== "firefox" && family !== "unknown");
  if (nonFirefoxFamily) {
    return nonFirefoxFamily;
  }
  if (userAgentFamilies.includes("firefox")) {
    return "firefox";
  }
  const sourceFamily = String(
    fingerprint?.source?.browser || fingerprint?.source?.normalizedBrowser || ""
  ).trim();
  if (sourceFamily) {
    return normalizeBrowserFamily(sourceFamily, "unknown");
  }
  return "unknown";
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

function hashString32(s) {
  let h = 2166136261;
  const text = String(s || "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pick(items, fallback = null) {
  if (!Array.isArray(items) || !items.length) {
    return fallback;
  }
  return items[Math.floor(Math.random() * items.length)];
}

export function detectDefaults() {
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

function uaParts(options = {}) {
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

function webglDefaultsFor(os, browser = "firefox") {
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

function fontDefaultsFor(os) {
  if (os === "macos") {
    return ["Arial", "Helvetica", "Times New Roman", "Courier New", "Menlo", "Apple Color Emoji"];
  }
  if (os === "linux") {
    return ["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Noto Color Emoji"];
  }
  return ["Arial", "Calibri", "Cambria", "Times New Roman", "Segoe UI", "Courier New", "Segoe UI Emoji"];
}

function randomGenerateOptions() {
  const defaults = detectDefaults();
  const os = defaults.os;
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
  const language = "zh-CN";
  const languages = normalizeLanguages(language, null);
  return {
    browser: "firefox",
    os,
    firefoxVersion: defaults.firefoxVersion,
    language,
    languages,
    locale: language,
    resolution: pick(screenPools[os], "1920x1080"),
    timezone: "Asia/Shanghai",
    acceptLanguage: acceptLanguageFrom(languages),
    region: DEFAULT_ENV_REGION,
    devicePixelRatio: pick(dprPools[os], 1),
    hardwareConcurrency: pick([4, 6, 8, 8, 12, 16], 8),
  };
}

export function firefoxGenerateOptions(options = {}) {
  const defaults = detectDefaults();
  const input = options && typeof options === "object" && !Array.isArray(options) ? { ...options } : {};
  const language = String(input.language || input.locale || "zh-CN").trim() || "zh-CN";
  const languages = normalizeLanguages(language, input.languages);
  const locale = String(input.locale || language).trim() || language;
  const timezone = String(input.timezone || "Asia/Shanghai").trim() || "Asia/Shanghai";
  const acceptLanguage = String(input.acceptLanguage || acceptLanguageFrom(languages)).trim();
  const navigatorOptions = { ...(input.navigator || {}) };
  const httpOptions = { ...(input.http || {}) };
  const webglOptions = { ...(input.webgl || {}) };
  const tlsOptions = { ...(input.tls || {}) };

  for (const key of ["userAgent", "appVersion", "productSub", "vendor", "userAgentData", "plugins", "mimeTypes", "oscpu", "buildID"]) {
    delete navigatorOptions[key];
  }
  for (const key of ["userAgent", "secChUa", "secChUaMobile", "secChUaPlatform", "secChUaFullVersionList", "secChUaArch", "secChUaBitness", "secChUaModel", "secChUaPlatformVersion"]) {
    delete httpOptions[key];
  }
  for (const key of ["vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"]) {
    delete webglOptions[key];
  }
  for (const key of ["chromeVersion", "chromiumVersion", "userAgent", "platform", "version"]) {
    delete input[key];
  }

  return {
    ...input,
    browser: "firefox",
    browserFamily: "firefox",
    os: defaults.os,
    firefoxVersion: defaults.firefoxVersion,
    language,
    languages,
    locale,
    timezone,
    acceptLanguage,
    region: language.toLowerCase() === "zh-cn" && locale.toLowerCase() === "zh-cn" && timezone === "Asia/Shanghai" ? DEFAULT_ENV_REGION : "custom",
    navigator: navigatorOptions,
    http: httpOptions,
    webgl: webglOptions,
    tls: { ...tlsOptions, mode: "firefox-default" },
  };
}

export function buildFingerprint(env, options = {}, source = { type: "generated" }) {
  const defaults = detectDefaults();
  const randomOptions = options && options.randomize ? randomGenerateOptions(options) : {};
  if ((options.consistencyMode || env.consistencyMode) === NATIVE_CONSISTENCY_MODE) {
    for (const key of ["resolution", "devicePixelRatio", "hardwareConcurrency"]) delete randomOptions[key];
  }
  const merged = { ...defaults, ...randomOptions, ...options };
  const ua = uaParts(merged);
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
  const webglDefaults = webglDefaultsFor(ua.os, browser);
  const fontDefaults = fontDefaultsFor(ua.os);
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
  const fingerprint = {
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
        ...(merged.region ? { region: String(merged.region) } : {}),
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
      appVersion: field(configString(navigatorOptions, "appVersion", isChromium ? userAgent.replace(/^Mozilla\//, "") : `5.0 (${ua.os === "macos" ? "Macintosh" : ua.os === "windows" ? "Windows" : "X11"})`)),
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
      plugins: field(configArray(navigatorOptions, "plugins", chromePlugins)),
      mimeTypes: field(configArray(navigatorOptions, "mimeTypes", chromeMimeTypes)),
      ...(isChromium
        ? { userAgentData: field(configJSON(navigatorOptions, "userAgentData", defaultUserAgentData)) }
        : {}),
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
      ...(isChromium
        ? {
            secChUa: field(configString(httpOptions, "secChUa", secChUaFromBrands(chromeBrandInfo.brands))),
            secChUaMobile: field(configString(httpOptions, "secChUaMobile", "?0")),
            secChUaPlatform: field(configString(httpOptions, "secChUaPlatform", `"${ua.uaPlatform}"`)),
            secChUaFullVersionList: field(configString(httpOptions, "secChUaFullVersionList", secChUaFromBrands(chromeBrandInfo.fullVersionList))),
            secChUaArch: field(configString(httpOptions, "secChUaArch", '"x86"')),
            secChUaBitness: field(configString(httpOptions, "secChUaBitness", '"64"')),
            secChUaModel: field(configString(httpOptions, "secChUaModel", '""')),
            secChUaPlatformVersion: field(configString(httpOptions, "secChUaPlatformVersion", `"${defaultUserAgentData.platformVersion}"`)),
          }
        : {}),
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
  return (options.consistencyMode || env.consistencyMode) === NATIVE_CONSISTENCY_MODE
    ? nativeFingerprintDefaults(fingerprint, env.audioSeed || randHex(32))
    : fingerprint;
}

export function defaultFingerprint(env) {
  return buildFingerprint(env, { enabled: true }, { type: "generated-default" });
}

export function validateFingerprint(fingerprint) {
  validateNativeFingerprint(fingerprint);
  if (!isNativeFingerprint(fingerprint) || !fingerprint.enabled) return;
  const nativeUA = uaParts(detectDefaults());
  const platform = configString(fingerprint.navigator, "platform", "");
  const userAgent = configString(fingerprint.navigator, "userAgent", "");
  if ((platform && platform !== nativeUA.platform) || (userAgent && userAgent !== nativeUA.userAgent)) {
    throw new Error("native consistency requires the current Firefox version and host OS identity");
  }
  if (configString(fingerprint.fonts, "mode", "native") === "allowlist") {
    let installedFonts;
    try {
      installedFonts = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator).EnumerateAllFonts();
    } catch {
      throw new Error("cannot verify installed fonts on this machine");
    }
    validateNativeFingerprint(fingerprint, { installedFonts });
  }
}

function captureCanvas() {
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

function captureWebGL() {
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

function captureAudio() {
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

export function captureCurrentBrowser() {
  const nav = safe(() => globalThis.navigator, null);
  const scr = safe(() => globalThis.screen, null);
  const intl = safe(() => Intl.DateTimeFormat().resolvedOptions(), {});
  const languages = safe(() => Array.from(nav.languages || []), []);
  const webgl = captureWebGL();
  const canvas = captureCanvas();
  const audio = captureAudio();
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

export function fingerprintFromCapture(env, capture, source = {}) {
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
  const defaults = detectDefaults();
  const capturedOS = osFromUA(capturedUA, defaults.os);
  const preserveNativeDetails = capturedBrowser === "firefox" && capturedOS === defaults.os;
  const firefoxVersion = defaults.firefoxVersion;
  const firefoxUA = uaParts({ os: defaults.os, firefoxVersion });
  const capturedLanguage = unwrapField(nav.language, unwrapField(intl.locale, "zh-CN"));
  const capturedTimezone = unwrapField(intl.timezone, unwrapField(intl.timeZone, "Asia/Shanghai"));
  return buildFingerprint(
    env,
    {
      enabled: true,
      browser: "firefox",
      os: defaults.os,
      firefoxVersion,
      userAgent: firefoxUA.userAgent,
      platform: firefoxUA.platform,
      language: capturedLanguage,
      languages: unwrapField(nav.languages, null),
      navigator: {
        maxTouchPoints: unwrapField(nav.maxTouchPoints, null),
        cookieEnabled: unwrapField(nav.cookieEnabled, true),
        pdfViewerEnabled: unwrapField(nav.pdfViewerEnabled, true),
        doNotTrack: unwrapField(nav.doNotTrack, null),
        plugins: preserveNativeDetails ? unwrapField(nav.plugins, []) : [],
        mimeTypes: preserveNativeDetails ? unwrapField(nav.mimeTypes, []) : [],
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
      timezone: capturedTimezone,
      locale: unwrapField(intl.locale, capturedLanguage),
      intl: {
        calendar: unwrapField(intl.calendar, ""),
        numberingSystem: unwrapField(intl.numberingSystem, ""),
        timezoneOffset: unwrapField(intl.timezoneOffset, null),
      },
      acceptLanguage: unwrapField(http.acceptLanguage, null),
      webgl: preserveNativeDetails ? {
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
      } : {},
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
      normalizedBrowser: "firefox",
      normalizedFromNonFirefox: capturedBrowser !== "firefox",
    }
  );
}
