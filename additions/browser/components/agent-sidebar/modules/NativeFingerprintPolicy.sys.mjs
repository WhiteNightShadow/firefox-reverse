/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const NATIVE_CONSISTENCY_MODE = "native-consistent";
export const isNativeFingerprint = config => config?.consistency?.mode === NATIVE_CONSISTENCY_MODE;
const field = (value, enabled = true) => ({ enabled, value });
const unwrap = value => value && typeof value === "object" && Object.hasOwn(value, "value") ? value.value : value;

function active(group, key, fallback = null) {
  if (group?.enabled === false) return fallback;
  const raw = group?.[key];
  if (raw === undefined) return fallback;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${key}.enabled must be boolean`);
    if (raw.enabled === false) return fallback;
    if (!Object.hasOwn(raw, "value")) throw new Error(`${key}.value required`);
    return raw.value;
  }
  return raw;
}

export function nativeFingerprintDefaults(config, audioSeed) {
  const next = JSON.parse(JSON.stringify(config));
  next.consistency = { mode: NATIVE_CONSISTENCY_MODE, version: 1 };
  // Retain captured values as inactive metadata, never partial display spoofing.
  for (const name of ["screen", "window", "webgl"]) {
    if (!next[name] || typeof next[name] !== "object" || Array.isArray(next[name])) next[name] = {};
    for (const [key, value] of Object.entries(next[name] || {})) {
      if (key !== "enabled") next[name][key] = field(unwrap(value), false);
    }
  }
  next.screen.enabled = false;
  next.window.enabled = false;
  if (Object.hasOwn(next, "devicePixelRatio")) next.devicePixelRatio = field(unwrap(next.devicePixelRatio), false);
  next.webgl.enabled = true;
  next.webgl.mode = field("native");
  next.webgl.msaaSamples = field(null, false);
  // Follow the installed engine across upgrades instead of pinning its UA to
  // the version that happened to create this environment.
  for (const key of ["userAgent", "platform", "appCodeName", "appName", "appVersion", "product", "productSub", "vendor", "vendorSub", "oscpu", "buildID", "userAgentData", "plugins", "mimeTypes", "maxTouchPoints", "cookieEnabled", "pdfViewerEnabled", "doNotTrack"]) {
    if (next.navigator && Object.hasOwn(next.navigator, key)) next.navigator[key] = field(unwrap(next.navigator[key]), false);
  }
  for (const key of Object.keys(next.http || {})) {
    if (key === "userAgent" || key.startsWith("secChUa")) next.http[key] = field(unwrap(next.http[key]), false);
  }
  if (next.navigator?.hardwareConcurrency) next.navigator.hardwareConcurrency.enabled = false;
  next.canvas = { enabled: true, mode: field("native"), backend: field("native") };
  next.audio = { enabled: true, mode: field("native"), scope: field("profile"), seed: field(audioSeed, false) };
  next.fonts = { enabled: true, mode: field("native"), families: field([], false) };
  next.protection = { resistFingerprinting: field(false), fingerprintingProtection: field(false) };
  for (const key of ["calendar", "numberingSystem", "timezoneOffset"]) {
    if (next.intl && Object.hasOwn(next.intl, key)) next.intl[key] = field(unwrap(next.intl[key]), false);
  }
  return next;
}

export function validateNativeFingerprint(config, { installedFonts } = {}) {
  if (!isNativeFingerprint(config)) {
    if (config?.consistency && config.consistency.mode !== "legacy") throw new Error("unsupported fingerprint consistency mode");
    return;
  }
  if (config.consistency.version !== 1) throw new Error("unsupported fingerprint consistency version");
  if (new TextEncoder().encode(JSON.stringify(config)).length > 1024 * 1024) throw new Error("fingerprint configuration exceeds 1 MiB");
  if (typeof config.enabled !== "boolean") throw new Error("fingerprint.enabled must be boolean");
  if (!config.enabled) return;
  if (active(config.protection, "resistFingerprinting", false) || active(config.protection, "fingerprintingProtection", false)) throw new Error("RFP/FPP cannot be combined with native-consistent overrides");
  for (const group of ["navigator", "screen", "window", "webgl", "canvas", "audio", "fonts", "http", "intl"]) {
    const value = config[group];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${group} must be an object`);
    if (value?.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error(`${group}.enabled must be boolean`);
  }
  const ua = active(config.navigator, "userAgent");
  const httpUA = active(config.http, "userAgent");
  if ([ua, httpUA].some(value => value && (!/Firefox\//.test(value) || /Chrome\//.test(value)))) throw new Error("native consistency requires a Firefox identity");
  if (ua && httpUA && ua !== httpUA) throw new Error("navigator and HTTP User-Agent must match");
  const language = active(config.navigator, "language");
  const languages = active(config.navigator, "languages");
  const locale = active(config.intl, "locale");
  const timezone = active(config.intl, "timezone");
  if (languages !== null && (!Array.isArray(languages) || !languages.length || languages.some(value => typeof value !== "string"))) throw new Error("navigator.languages must be a nonempty language list");
  for (const value of [language, locale, ...(languages || [])]) {
    if (value !== null && (typeof value !== "string" || !value || !Intl.getCanonicalLocales(value).length)) throw new Error("invalid locale/language tag");
  }
  if (language && languages && language !== languages[0]) throw new Error("navigator.language must match the first language");
  const acceptLanguage = active(config.http, "acceptLanguage");
  if (acceptLanguage !== null) {
    if (typeof acceptLanguage !== "string" || /[\r\n\0]/.test(acceptLanguage)) throw new Error("invalid Accept-Language");
    const first = acceptLanguage.split(",")[0].split(";")[0].trim();
    if (language && first.toLowerCase() !== language.toLowerCase()) throw new Error("Accept-Language must match the primary navigator language");
  }
  if (timezone !== null) {
    if (typeof timezone !== "string" || !timezone) throw new Error("invalid timezone");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions();
  }
  if (active(config.navigator, "userAgentData") || Object.keys(config.http || {}).some(key => /^secChUa/.test(key) && active(config.http, key))) throw new Error("UA-CH is not supported in native consistency mode");
  for (const group of ["screen", "window"]) {
    for (const key of Object.keys(config[group] || {})) {
      if (key !== "enabled" && active(config[group], key) !== null) throw new Error("complete display simulation is not available; keep Screen/DPR native");
    }
  }
  if (active(config, "devicePixelRatio") !== null) throw new Error("keep devicePixelRatio native");
  for (const key of Object.keys(config.webgl || {})) {
    if (!["enabled", "mode", "msaaSamples"].includes(key) && active(config.webgl, key) !== null) throw new Error(`native WebGL cannot override ${key}`);
  }
  if (active(config.webgl, "mode", "native") !== "native") throw new Error("WebGL mode must be native");
  if (![null, 0, 4].includes(active(config.webgl, "msaaSamples"))) throw new Error("WebGL MSAA must be native, 0 or 4");
  if (active(config.canvas, "mode", "native") !== "native") throw new Error("Canvas seeded mode is not supported");
  if (!["native", "software"].includes(active(config.canvas, "backend", "native"))) throw new Error("Canvas backend must be native or software");
  for (const key of ["seed", "noise"]) {
    if (active(config.canvas, key) !== null) throw new Error(`Canvas ${key} has no native consumer`);
  }
  const audio = config.audio;
  const audioMode = active(audio, "mode", "native");
  if (!["native", "seeded"].includes(audioMode)) throw new Error("Audio mode must be native or seeded");
  if (audioMode === "seeded") {
    if (config.seed_mode !== "persistent" || active(audio, "scope", "profile") !== "profile") throw new Error("Offline Audio seed requires persistent profile scope");
    if (!/^[a-fA-F0-9]{64}$/.test(active(audio, "seed") || "")) throw new Error("Offline Audio requires an active 64-hex seed");
    if (audio.seed && typeof audio.seed === "object" && audio.seed.enabled !== true) throw new Error("Offline Audio seed must be explicitly enabled");
    for (const key of ["sampleRate", "noise", "baseLatency", "outputLatency"]) {
      if (active(audio, key) !== null) throw new Error(`Offline Audio seed conflicts with ${key}`);
    }
  } else {
    if (![null, 44100, 48000].includes(active(audio, "sampleRate"))) throw new Error("Audio sampleRate must be native, 44100 or 48000");
    for (const key of ["noise", "baseLatency", "outputLatency"]) {
      if (active(audio, key) !== null) throw new Error(`Audio ${key} has no native consumer`);
    }
  }
  const fonts = config.fonts;
  const fontMode = active(fonts, "mode", "native");
  if (!["native", "allowlist"].includes(fontMode)) throw new Error("Font mode must be native or allowlist");
  if (fontMode === "allowlist") {
    const names = active(fonts, "families");
    if (!Array.isArray(names) || !names.length || names.length > 4096) throw new Error("font allowlist must contain 1-4096 installed families");
    const seen = new Set();
    const inventory = installedFonts && new Set(installedFonts.map(name => name.toLowerCase()));
    for (const name of names) {
      if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.length > 256 || /[,\x00-\x1f\x7f]/.test(name)) throw new Error("invalid font family name");
      const key = name.toLowerCase();
      if (seen.has(key)) throw new Error(`duplicate font family: ${name}`);
      seen.add(key);
      if (inventory && !inventory.has(key)) throw new Error(`font is not installed: ${name}`);
    }
  } else if (active(fonts, "families") !== null) {
    throw new Error("font families require allowlist mode");
  }
}

// Emit resets too: deleting a user.js line does not undo its prefs.js value.
export function nativeRenderingPrefs(config, defaults = {}) {
  if (!isNativeFingerprint(config)) return {};
  validateNativeFingerprint(config);
  const enabled = config.enabled;
  const canvas = enabled ? config.canvas : null;
  const webgl = enabled ? config.webgl : null;
  const audio = enabled ? config.audio : null;
  const fonts = enabled ? config.fonts : null;
  const allowlist = active(fonts, "mode", "native") === "allowlist";
  const fallback = (key, value) => defaults[key] ?? value;
  return {
    "gfx.canvas.accelerated": active(canvas, "backend", "native") === "software" ? false : fallback("gfx.canvas.accelerated", true),
    "gfx.canvas.accelerated.force-enabled": active(canvas, "backend", "native") === "software" ? false : fallback("gfx.canvas.accelerated.force-enabled", false),
    "gfx.canvas.azure.backends": active(canvas, "backend", "native") === "software" ? "skia" : fallback("gfx.canvas.azure.backends", "skia"),
    "webgl.msaa-samples": active(webgl, "msaaSamples") ?? fallback("webgl.msaa-samples", 4),
    "webgl.override-unmasked-vendor": "",
    "webgl.override-unmasked-renderer": "",
    "webgl.sanitize-unmasked-renderer": fallback("webgl.sanitize-unmasked-renderer", true),
    "webgl.power-preference-override": fallback("webgl.power-preference-override", 0),
    "media.cubeb.force_sample_rate": active(audio, "sampleRate") ?? 0,
    "font.system.whitelist": allowlist ? active(fonts, "families").join(",") : "",
    "layout.css.font-visibility": fallback("layout.css.font-visibility", 3),
    "gfx.e10s.font-list.shared": allowlist ? false : fallback("gfx.e10s.font-list.shared", true),
    "gfx.font_loader.delay": allowlist ? 0 : fallback("gfx.font_loader.delay", 8000),
    "frx.fingerprint.fonts.whitelist_local_lookup": allowlist,
  };
}
