/* EnvironmentCommon.sys.mjs — 环境后端各模块共用的常量和小工具。 */

export const SCHEMA_VERSION = 1;
export const DEFAULT_PORT_BASE = 2828;
export const MAX_PORT_SCAN = 200;
export const PROCESS_ALIVE = "alive";
export const PROCESS_DEAD = "dead";
export const PROCESS_UNKNOWN = "unknown";
let timerModuleCache;

export function nowISO() {
  return new Date().toISOString();
}

function getTimerModule() {
  if (timerModuleCache === undefined) {
    timerModuleCache = lazyESM("resource://gre/modules/Timer.sys.mjs") || null;
  }
  return timerModuleCache;
}

export function scheduleTimeout(callback, ms) {
  const fn = getTimerModule()?.setTimeout || globalThis.setTimeout;
  if (typeof fn !== "function") {
    throw new Error("timer service unavailable");
  }
  return fn(callback, ms);
}

export function cancelTimeout(id) {
  const fn = getTimerModule()?.clearTimeout || globalThis.clearTimeout;
  if (typeof fn === "function") {
    fn(id);
  }
}

export function delay(ms) {
  return new Promise(resolve => scheduleTimeout(resolve, ms));
}

export function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function isRuntimeActive(runtime) {
  const status = String(runtime?.status || "").toLowerCase();
  return status === "running" || status === "starting" || status === "closing";
}

export function lazyESM(url) {
  try {
    return ChromeUtils.importESModule(url);
  } catch {
    return null;
  }
}

export function randHex(bytes = 8) {
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

export function field(value, enabled = true) {
  return { enabled, value };
}

export function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

export function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

export function unwrapField(v, fallback = null) {
  if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
    return v.value;
  }
  return v == null ? fallback : v;
}

export function configField(parent, key, fallback = null) {
  if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) {
    return fallback;
  }
  const v = parent[key];
  if (v && typeof v === "object" && v.enabled === false) {
    return fallback;
  }
  return unwrapField(v, fallback);
}

export function configBool(parent, key, fallback = false) {
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

export function configInt(parent, key, min, max, fallback) {
  return clampInt(configField(parent, key, fallback), min, max, fallback);
}

export function configNumber(parent, key, min, max, fallback) {
  return clampNumber(configField(parent, key, fallback), min, max, fallback);
}

export function configString(parent, key, fallback = "") {
  const v = configField(parent, key, fallback);
  return v == null ? fallback : String(v);
}

export function configArray(parent, key, fallback = []) {
  const v = configField(parent, key, fallback);
  return Array.isArray(v) ? v : fallback;
}

export function configJSON(parent, key, fallback = null) {
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

export function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function shortEnv(env) {
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

export function envDisplayName(env) {
  return String(env?.name || env?.id || "Firefox Reverse Environment").trim();
}

export function processLabelFor(env) {
  return envDisplayName(env);
}

export function processSlotLabel(port) {
  const n = Number(port);
  if (Number.isFinite(n) && n >= DEFAULT_PORT_BASE && n < DEFAULT_PORT_BASE + MAX_PORT_SCAN) {
    return `Firefox Reverse ${n - DEFAULT_PORT_BASE + 1}`;
  }
  return "Firefox Reverse";
}

// 当前浏览器进程是不是由环境后端拉起的环境（是则返回环境 id）。
export function currentEnvId() {
  return (
    safe(() => Services.env.get("MOZ_FRX_ENV_ID"), "") ||
    safe(() => Services.env.get("FRX_ENV_ID"), "") ||
    safe(() => Services.prefs.getStringPref("frx.environment.id", ""), "")
  ).trim();
}

export function currentMarionettePort() {
  return safe(() => Services.prefs.getIntPref("marionette.port", DEFAULT_PORT_BASE), DEFAULT_PORT_BASE);
}
