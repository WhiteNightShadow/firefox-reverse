import React, { useEffect, useMemo, useRef, useState } from "react";

const CURRENT_PROCESS_TARGET = "__current_process__";

const EXTERNAL_CAPTURE_SCRIPT = String.raw`(() => {
  const safe = (fn, fallback = null) => {
    try { return fn(); } catch { return fallback; }
  };
  const hash32 = value => {
    let h = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const listPlugins = () => safe(() => Array.from(navigator.plugins || []).map(p => ({
    name: p.name || "",
    filename: p.filename || "",
    description: p.description || "",
    mimeTypes: Array.from(p || []).map(m => m.type || "").filter(Boolean),
  })), []);
  const listMimeTypes = () => safe(() => Array.from(navigator.mimeTypes || []).map(m => ({
    type: m.type || "",
    suffixes: m.suffixes || "",
    description: m.description || "",
    enabledPlugin: m.enabledPlugin ? m.enabledPlugin.name || "" : "",
  })), []);
  const userAgentData = () => safe(() => {
    const ua = navigator.userAgentData;
    if (!ua) return null;
    return {
      brands: Array.from(ua.brands || []),
      mobile: ua.mobile,
      platform: ua.platform || "",
    };
  }, null);
  const quote = value => '"' + String(value || "").replace(/"/g, '\\"') + '"';
  const secChUa = brands => Array.from(brands || [])
    .filter(b => b && b.brand && b.version)
    .map(b => quote(b.brand) + ';v=' + quote(b.version))
    .join(", ");
  const captureCanvas = () => safe(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
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
    return { hash: hash32(dataURL), dataUrlLength: dataURL.length };
  }, null);
  const captureWebGL = () => safe(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return null;
    const ext = safe(() => gl.getExtension("WEBGL_debug_renderer_info"), null);
    const aniso = safe(() => gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") || gl.getExtension("MOZ_EXT_texture_filter_anisotropic"), null);
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
  const captureAudio = () => safe(() => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
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
  const nav = navigator;
  const scr = screen;
  const intl = safe(() => Intl.DateTimeFormat().resolvedOptions(), {});
  const languages = safe(() => Array.from(nav.languages || []), []);
  const uaData = userAgentData();
  const brands = uaData && uaData.brands ? uaData.brands : [];
  const capture = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: { type: "external-browser-console", url: location.href },
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
      userAgentData: uaData,
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
      orientation: safe(() => scr.orientation ? { type: scr.orientation.type || "", angle: scr.orientation.angle || 0 } : null, null),
    },
    window: {
      devicePixelRatio: safe(() => window.devicePixelRatio, null),
      innerWidth: safe(() => window.innerWidth, null),
      innerHeight: safe(() => window.innerHeight, null),
      outerWidth: safe(() => window.outerWidth, null),
      outerHeight: safe(() => window.outerHeight, null),
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
      acceptLanguage: languages.join(","),
      secChUa: secChUa(brands),
      secChUaMobile: uaData ? (uaData.mobile ? "?1" : "?0") : "",
      secChUaPlatform: uaData && uaData.platform ? quote(uaData.platform) : "",
    },
    webgl: captureWebGL(),
    canvas: captureCanvas(),
    audio: captureAudio(),
    fonts: { queryLocalFonts: safe(() => typeof window.queryLocalFonts === "function", false) },
    storage: {
      localStorage: safe(() => typeof window.localStorage === "object", false),
      sessionStorage: safe(() => typeof window.sessionStorage === "object", false),
      indexedDB: safe(() => typeof window.indexedDB === "object", false),
      cookie: safe(() => document.cookie || "", ""),
    },
  };
  const json = JSON.stringify(capture, null, 2);
  window.__FRX_CAPTURE_JSON__ = json;
  try {
    if (typeof copy === "function") {
      copy(json);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).catch(() => {});
    }
  } catch {}
  console.log("FRX_CAPTURE_JSON_START\n" + json + "\nFRX_CAPTURE_JSON_END");
  prompt("Firefox Reverse 指纹采集 JSON：复制完整 JSON 后粘贴到环境管理的“导入”页签。也可在控制台执行 copy(window.__FRX_CAPTURE_JSON__)", json);
  return json;
})()`;

function shortPath(p) {
  if (!p) {
    return "";
  }
  const segs = String(p).replace(/\/+$/, "").split("/");
  return segs.length <= 3 ? p : ".../" + segs.slice(-3).join("/");
}

function fmtTime(ts) {
  if (!ts) {
    return "";
  }
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function statusText(rt) {
  const s = rt && rt.status;
  if (s === "running") {
    return "运行中";
  }
  if (s === "starting") {
    return "启动中";
  }
  if (s === "closing") {
    return "关闭中";
  }
  return "已停止";
}

function sourceText(source) {
  const type = source && source.type;
  if (type === "generated") {
    return "生成";
  }
  if (type === "imported-capture") {
    return "导入";
  }
  if (type === "generated-default") {
    return "默认";
  }
  return "未知";
}

function envStatusClass(rt) {
  const s = rt && rt.status;
  if (s === "running" || s === "starting") {
    return "running";
  }
  if (s === "closing") {
    return "closing";
  }
  return "stopped";
}

function isRuntimeActive(rt) {
  const s = rt && rt.status;
  return s === "running" || s === "starting" || s === "closing";
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function fieldValue(obj, section, key, fallback = "") {
  const v = obj && obj[section] && obj[section][key];
  if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
    return v.value ?? fallback;
  }
  return v ?? fallback;
}

function setField(obj, section, key, value) {
  const next = clone(obj);
  next[section] = next[section] || {};
  const old = next[section][key];
  if (old && typeof old === "object" && Object.prototype.hasOwnProperty.call(old, "value")) {
    next[section][key] = { ...old, enabled: old.enabled !== false, value };
  } else {
    next[section][key] = { enabled: true, value };
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function setTop(obj, key, value) {
  const next = clone(obj);
  next[key] = value;
  next.updatedAt = new Date().toISOString();
  return next;
}

function toText(obj) {
  try {
    return JSON.stringify(obj || {}, null, 2);
  } catch {
    return "{}";
  }
}

function parseList(v) {
  return String(v || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <label className="env-field">
      <span>{label}</span>
      <input type={type} value={value ?? ""} onChange={e => onChange(type === "number" ? Number(e.target.value) : e.target.value)} />
    </label>
  );
}

function SelectField({ label, value, onChange, children }) {
  return (
    <label className="env-field">
      <span>{label}</span>
      <select value={value ?? ""} onChange={e => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function CheckField({ label, checked, onChange }) {
  return (
    <label className="env-check env-check--field">
      <input type="checkbox" checked={checked === true} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function TextField({ label, value, onChange }) {
  return (
    <label className="env-field env-field--wide">
      <span>{label}</span>
      <textarea rows={3} value={value ?? ""} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function FingerprintForm({ fingerprint, setFingerprint }) {
  if (!fingerprint) {
    return null;
  }
  const nav = fingerprint.navigator || {};
  const screen = fingerprint.screen || {};
  const win = fingerprint.window || {};
  const intl = fingerprint.intl || {};
  const http = fingerprint.http || {};
  const webgl = fingerprint.webgl || {};
  const audio = fingerprint.audio || {};
  const fonts = fingerprint.fonts || {};
  const webrtc = fingerprint.webrtc || {};
  const tls = fingerprint.tls || {};
  const protection = fingerprint.protection || {};
  const set = (section, key, value) => setFingerprint(fp => setField(fp, section, key, value));
  return (
    <div className="env-editor">
      <label className="env-check">
        <input type="checkbox" checked={fingerprint.enabled !== false} onChange={e => setFingerprint(fp => setTop(fp, "enabled", e.target.checked))} />
        <span>启用指纹覆盖</span>
      </label>

      <div className="env-editor__grid">
        <TextField label="User-Agent" value={fieldValue({ navigator: nav }, "navigator", "userAgent")} onChange={v => set("navigator", "userAgent", v)} />
        <Field label="platform" value={fieldValue({ navigator: nav }, "navigator", "platform")} onChange={v => set("navigator", "platform", v)} />
        <Field label="language" value={fieldValue({ navigator: nav }, "navigator", "language")} onChange={v => set("navigator", "language", v)} />
        <Field label="languages" value={(fieldValue({ navigator: nav }, "navigator", "languages", []) || []).join(",")} onChange={v => set("navigator", "languages", parseList(v))} />
        <Field label="hardwareConcurrency" type="number" value={fieldValue({ navigator: nav }, "navigator", "hardwareConcurrency", 8)} onChange={v => set("navigator", "hardwareConcurrency", v)} />
        <label className="env-check env-check--field">
          <input type="checkbox" checked={fieldValue({ navigator: nav }, "navigator", "webdriver", false) === true} onChange={e => set("navigator", "webdriver", e.target.checked)} />
          <span>webdriver=true</span>
        </label>
        <Field label="screen.width" type="number" value={fieldValue({ screen }, "screen", "width", 1920)} onChange={v => set("screen", "width", v)} />
        <Field label="screen.height" type="number" value={fieldValue({ screen }, "screen", "height", 1080)} onChange={v => set("screen", "height", v)} />
        <Field label="availWidth" type="number" value={fieldValue({ screen }, "screen", "availWidth", 1920)} onChange={v => set("screen", "availWidth", v)} />
        <Field label="availHeight" type="number" value={fieldValue({ screen }, "screen", "availHeight", 1040)} onChange={v => set("screen", "availHeight", v)} />
        <Field label="colorDepth" type="number" value={fieldValue({ screen }, "screen", "colorDepth", 24)} onChange={v => set("screen", "colorDepth", v)} />
        <Field label="pixelDepth" type="number" value={fieldValue({ screen }, "screen", "pixelDepth", 24)} onChange={v => set("screen", "pixelDepth", v)} />
        <Field label="devicePixelRatio" type="number" value={fieldValue({ window: win }, "window", "devicePixelRatio", 1)} onChange={v => set("window", "devicePixelRatio", v)} />
        <Field label="Intl locale" value={fieldValue({ intl }, "intl", "locale")} onChange={v => set("intl", "locale", v)} />
        <Field label="Intl timezone" value={fieldValue({ intl }, "intl", "timezone")} onChange={v => set("intl", "timezone", v)} />
        <TextField label="HTTP User-Agent" value={fieldValue({ http }, "http", "userAgent")} onChange={v => set("http", "userAgent", v)} />
        <Field label="Accept-Language" value={fieldValue({ http }, "http", "acceptLanguage")} onChange={v => set("http", "acceptLanguage", v)} />
      </div>

      <div className="env-editor__grid">
        <Field label="WebGL vendor" value={fieldValue({ webgl }, "webgl", "vendor", "Mozilla")} onChange={v => set("webgl", "vendor", v)} />
        <Field label="WebGL renderer" value={fieldValue({ webgl }, "webgl", "renderer", "Mozilla")} onChange={v => set("webgl", "renderer", v)} />
        <Field label="unmaskedVendor" value={fieldValue({ webgl }, "webgl", "unmaskedVendor", "")} onChange={v => set("webgl", "unmaskedVendor", v)} />
        <TextField label="unmaskedRenderer" value={fieldValue({ webgl }, "webgl", "unmaskedRenderer", "")} onChange={v => set("webgl", "unmaskedRenderer", v)} />
        <Field label="WebGL powerPreference" type="number" value={fieldValue({ webgl }, "webgl", "powerPreferenceOverride", 0)} onChange={v => set("webgl", "powerPreferenceOverride", v)} />
        <CheckField label="sanitize WebGL" checked={fieldValue({ webgl }, "webgl", "sanitizeUnmaskedRenderer", true)} onChange={v => set("webgl", "sanitizeUnmaskedRenderer", v)} />

        <Field label="Audio sampleRate" type="number" value={fieldValue({ audio }, "audio", "sampleRate", 48000)} onChange={v => set("audio", "sampleRate", v)} />
        <Field label="font visibility" type="number" value={fieldValue({ fonts }, "fonts", "visibility", 3)} onChange={v => set("fonts", "visibility", v)} />

        <SelectField label="WebRTC mode" value={fieldValue({ webrtc }, "webrtc", "mode", "default_address_only")} onChange={v => set("webrtc", "mode", v)}>
          <option value="default_address_only">default_address_only</option>
          <option value="relay_only">relay_only</option>
          <option value="disabled">disabled</option>
        </SelectField>
        <CheckField label="WebRTC no_host" checked={fieldValue({ webrtc }, "webrtc", "noHost", true)} onChange={v => set("webrtc", "noHost", v)} />
        <CheckField label="mDNS hostnames" checked={fieldValue({ webrtc }, "webrtc", "obfuscateHostAddresses", true)} onChange={v => set("webrtc", "obfuscateHostAddresses", v)} />

        <Field label="TLS min" type="number" value={fieldValue({ tls }, "tls", "minVersion", 3)} onChange={v => set("tls", "minVersion", v)} />
        <Field label="TLS max" type="number" value={fieldValue({ tls }, "tls", "maxVersion", 4)} onChange={v => set("tls", "maxVersion", v)} />
        <CheckField label="HTTP/3" checked={fieldValue({ tls }, "tls", "http3", true)} onChange={v => set("tls", "http3", v)} />
        <CheckField label="ALPN" checked={fieldValue({ tls }, "tls", "alpn", true)} onChange={v => set("tls", "alpn", v)} />
        <CheckField label="0-RTT" checked={fieldValue({ tls }, "tls", "zeroRtt", false)} onChange={v => set("tls", "zeroRtt", v)} />
        <CheckField label="ECH GREASE" checked={fieldValue({ tls }, "tls", "echGrease", true)} onChange={v => set("tls", "echGrease", v)} />
        <CheckField label="Kyber" checked={fieldValue({ tls }, "tls", "kyber", true)} onChange={v => set("tls", "kyber", v)} />
        <CheckField label="RFP" checked={fieldValue({ protection }, "protection", "resistFingerprinting", false)} onChange={v => set("protection", "resistFingerprinting", v)} />
        <CheckField label="FPP" checked={fieldValue({ protection }, "protection", "fingerprintingProtection", false)} onChange={v => set("protection", "fingerprintingProtection", v)} />
      </div>
    </div>
  );
}

export default function EnvironmentPane({ env, onClose }) {
  const currentProcessEnvRef = useRef(null);
  const [items, setItems] = useState([]);
  const [currentProcess, setCurrentProcess] = useState(null);
  const [root, setRoot] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("form");
  const [fingerprint, setFingerprint] = useState(null);
  const [fpText, setFpText] = useState("");
  const [importText, setImportText] = useState("");

  const selected = useMemo(() => items.find(x => x.id === selectedId) || null, [items, selectedId]);
  const currentProcessSelected = selectedId === CURRENT_PROCESS_TARGET;
  const running = currentProcessSelected ? true : selected && isRuntimeActive(selected.runtime);
  const stats = useMemo(() => {
    const runningCount = items.filter(x => isRuntimeActive(x.runtime)).length;
    const stoppedCount = Math.max(0, items.length - runningCount);
    const ports = items
      .map(x => x.runtime?.marionettePort)
      .filter(Boolean)
      .map(String);
    return {
      total: items.length,
      running: runningCount,
      stopped: stoppedCount,
      ports: ports.length ? ports.join(", ") : "无",
    };
  }, [items]);

  async function refresh(preferredId = selectedId) {
    if (!env) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await env.list({ refresh: true });
      const nextItems = res.environments || [];
      setItems(nextItems);
      setRoot(res.root || "");
      const currentApi = await getCurrentProcessApi("currentProcess", { silent: true });
      const current = currentApi ? await currentApi.currentProcess({ refresh: false }).catch(() => null) : null;
      setCurrentProcess(current);
      let currentId = "";
      if (!preferredId && env.current) {
        const current = await env.current({ refresh: false }).catch(() => null);
        currentId = current?.id || "";
      }
      const wantedId = preferredId || currentId;
      const nextSelected =
        wantedId === CURRENT_PROCESS_TARGET
          ? CURRENT_PROCESS_TARGET
          : wantedId && nextItems.some(x => x.id === wantedId)
            ? wantedId
            : nextItems[0]?.id || "";
      setSelectedId(nextSelected);
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadConfig(id) {
    if (!env || !id) {
      setFingerprint(null);
      setFpText("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const currentApi =
        id === CURRENT_PROCESS_TARGET
          ? await getCurrentProcessApi("readCurrentProcessConfig")
          : null;
      if (id === CURRENT_PROCESS_TARGET && !currentApi) {
        setFingerprint(null);
        setFpText("");
        return;
      }
      const fp =
        id === CURRENT_PROCESS_TARGET
          ? await currentApi.readCurrentProcessConfig({ type: "fingerprint" })
          : await env.readConfig({ id, type: "fingerprint" });
      setFingerprint(fp.config);
      setFpText(toText(fp.config));
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    loadConfig(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (tab !== "json" && fingerprint) {
      setFpText(toText(fingerprint));
    }
  }, [fingerprint, tab]);

  async function getCurrentProcessApi(name, { silent = false } = {}) {
    if (typeof env?.[name] === "function") {
      return env;
    }
    try {
      if (!currentProcessEnvRef.current) {
        const { EnvironmentBackend } = ChromeUtils.importESModule(
          "resource:///modules/agentsidebar/EnvironmentBackendCurrent.sys.mjs"
        );
        currentProcessEnvRef.current = new EnvironmentBackend();
      }
      if (typeof currentProcessEnvRef.current?.[name] === "function") {
        return currentProcessEnvRef.current;
      }
    } catch (e) {
      if (!silent) {
        setError(`当前主进程指纹后端加载失败：${(e && e.message) || String(e)}`);
      }
      return null;
    }
    if (!silent) {
      const available = [
        ...Object.keys(env || {}),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(env || {})),
      ].filter(x => x && x !== "constructor").sort().join(", ");
      setError(`当前主进程指纹后端未加载完整，缺少 ${name}。已检测到的方法：${available || "无"}`);
    }
    return null;
  }

  async function createEnv() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await env.create({
        name: name.trim() || undefined,
        generateOptions: { randomize: true, browser: "chromium" },
      });
      setName("");
      setNotice("已一键新建环境");
      await refresh(res.environment?.id || "");
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openEnv(id) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await env.open({ id });
      await refresh(id);
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function promptCurrentProcessRestart(doneText, keptText) {
    window.alert(
      `${doneText}\n\n这个修改已经写入当前 profile，后续手动启动 Firefox Reverse 都会使用这套当前主进程配置。\n\n请你手动退出并重新打开 Firefox Reverse 后生效。`
    );
    setNotice(keptText || `${doneText}，已记住；手动重启后生效`);
  }

  function selectCurrentProcess() {
    const managedId = currentProcess?.managedEnvId || "";
    if (managedId && items.some(x => x.id === managedId)) {
      setSelectedId(managedId);
    } else {
      setSelectedId(CURRENT_PROCESS_TARGET);
    }
    setTab("form");
  }

  async function promptRename(item, e) {
    if (e) {
      e.stopPropagation();
    }
    if (!item || !item.id) {
      return;
    }
    const oldName = item.name || item.id;
    const nextName = window.prompt("修改环境名称", oldName);
    if (nextName == null) {
      return;
    }
    const cleanName = nextName.trim();
    if (!cleanName || cleanName === oldName) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await env.update({ id: item.id, name: cleanName });
      setNotice("已重命名");
      await refresh(item.id);
    } catch (e2) {
      setError((e2 && e2.message) || String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function closeEnv(id) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await env.close({ id });
      await refresh(id);
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteEnv(item) {
    const label = item.name || item.id;
    if (!window.confirm(`删除环境 "${label}"？`)) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await env.delete({ id: item.id, confirm: true });
      await refresh("");
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveFingerprint(fromJson = false) {
    if (!selectedId) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const config = fromJson ? JSON.parse(fpText) : fingerprint;
      const isCurrent = selectedId === CURRENT_PROCESS_TARGET;
      const currentApi = isCurrent ? await getCurrentProcessApi("writeCurrentProcessConfig") : null;
      if (isCurrent && !currentApi) {
        return;
      }
      const res = isCurrent
        ? await currentApi.writeCurrentProcessConfig({ type: "fingerprint", config })
        : await env.writeConfig({ id: selectedId, type: "fingerprint", config });
      setFingerprint(res.config);
      setFpText(toText(res.config));
      await refresh(selectedId);
      if (isCurrent) {
        await promptCurrentProcessRestart("当前主进程指纹已保存", "已保存，已记住；下次手动启动生效");
      } else {
        setNotice(running ? "已保存，重开环境后生效" : "已保存");
      }
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyCaptureScript() {
    setError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(EXTERNAL_CAPTURE_SCRIPT);
      setNotice("采集脚本已复制");
    } catch (e) {
      setError("复制失败，请手动复制导入框上方脚本");
    }
  }

  async function importPastedCapture() {
    if (!selectedId) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let capture = JSON.parse(importText.trim());
      if (typeof capture === "string") {
        capture = JSON.parse(capture);
      }
      const isCurrent = selectedId === CURRENT_PROCESS_TARGET;
      const currentApi = isCurrent ? await getCurrentProcessApi("importCurrentProcessFingerprint") : null;
      if (isCurrent && !currentApi) {
        return;
      }
      const res = isCurrent
        ? await currentApi.importCurrentProcessFingerprint({ capture })
        : await env.importFingerprint({ id: selectedId, capture });
      setFingerprint(res.fingerprint);
      setFpText(toText(res.fingerprint));
      await refresh(selectedId);
      if (isCurrent) {
        await promptCurrentProcessRestart("当前主进程指纹已导入", "已导入，已记住；下次手动启动生效");
      } else {
        setNotice(running ? "已导入，重开环境后生效" : "已导入");
      }
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resetCurrentProcessDefault() {
    const currentApi = await getCurrentProcessApi("resetCurrentProcessDefault");
    if (!currentApi) {
      return;
    }
    if (!window.confirm("一键还原默认会取消当前主进程指纹配置，并清理当前 profile 里由环境管理写入的相关 prefs。后续手动启动将恢复 Firefox Reverse 默认指纹。继续？")) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await currentApi.resetCurrentProcessDefault({ confirm: true });
      setFingerprint(null);
      setFpText("");
      await refresh(CURRENT_PROCESS_TARGET);
      await loadConfig(CURRENT_PROCESS_TARGET);
      await promptCurrentProcessRestart("当前主进程已还原默认", "已还原默认，重启后生效");
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setBusy(false);
    }
  }

  const currentManagedName =
    currentProcess?.managedEnvironment?.name ||
    currentProcess?.managedEnvironment?.id ||
    currentProcess?.managedEnvId ||
    "";
  const currentFingerprintPath = currentProcess?.activeFingerprintPath || currentProcess?.fingerprintPath || "";
  const currentProcessModeText = currentProcess?.managedEnvId
    ? `已绑定环境：${currentManagedName}`
    : currentProcess?.activeFingerprintPath
      ? "普通启动，主进程指纹已启用"
      : currentFingerprintPath
        ? "普通启动，主进程指纹已配置"
        : "普通启动，默认指纹";
  const detailActive = selected || currentProcessSelected;

  return (
    <div className="env-pane">
      <header className="env-pane__bar">
        <span className="env-pane__title">
          环境管理
          <em>{stats.running}/{stats.total} 运行</em>
        </span>
        <button type="button" onClick={onClose} title="返回 Agent">
          ×
        </button>
      </header>

      <div className="env-pane__toolbar">
        <input type="text" value={name} placeholder="环境名称" onChange={e => setName(e.target.value)} />
        <button type="button" className="is-primary" onClick={createEnv} disabled={busy}>
          一键新建环境
        </button>
      </div>

      <div className="env-stats">
        <div className="env-stat">
          <span>总环境</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="env-stat is-running">
          <span>运行中</span>
          <strong>{stats.running}</strong>
        </div>
        <div className="env-stat">
          <span>已停止</span>
          <strong>{stats.stopped}</strong>
        </div>
        <div className="env-stat env-stat--wide" title={stats.ports}>
          <span>端口</span>
          <strong>{stats.ports}</strong>
        </div>
      </div>

      {root && <div className="env-pane__root" title={root}>{shortPath(root)}</div>}
      {error && <div className="env-pane__error">{error}</div>}
      {notice && <div className="env-pane__notice">{notice}</div>}

      <div className={`env-current ${currentProcessSelected ? "is-selected" : ""}`}>
        <div className="env-current__main">
          <strong>当前主进程</strong>
          <span>{currentProcessModeText}</span>
          <small title={currentProcess?.profilePath || ""}>Profile：{shortPath(currentProcess?.profilePath || "")}</small>
          <small title={currentFingerprintPath}>
            指纹：{currentProcess?.activeFingerprintPath ? `已启用 ${shortPath(currentProcess.activeFingerprintPath)}` : currentFingerprintPath ? `已配置 ${shortPath(currentFingerprintPath)}` : "未启用，默认"}
          </small>
        </div>
        <button type="button" className="is-primary" onClick={selectCurrentProcess} disabled={busy}>
          {currentProcess?.managedEnvId ? "编辑当前环境" : "修改主进程指纹"}
        </button>
      </div>

      <div className="env-table-wrap">
        {items.length === 0 && !busy && <div className="env-pane__empty">暂无环境</div>}
        {items.length > 0 && (
          <table className="env-table">
            <thead>
              <tr>
                <th>操作</th>
                <th>环境</th>
                <th>状态</th>
                <th>指纹</th>
                <th>端口</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const rt = item.runtime || {};
                const stateClass = envStatusClass(rt);
                const isRunning = isRuntimeActive(rt);
                const isSelected = item.id === selectedId;
                const displayName = item.name || item.id || "未命名环境";
                return (
                  <tr key={item.id} className={`${isSelected ? "is-selected" : ""} is-${stateClass}`} onClick={() => setSelectedId(item.id)}>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="env-table__actions">
                        {isRunning ? (
                          <button type="button" onClick={() => closeEnv(item.id)} disabled={busy}>
                            关闭
                          </button>
                        ) : (
                          <button type="button" className="is-primary" onClick={() => openEnv(item.id)} disabled={busy}>
                            打开
                          </button>
                        )}
                        <button type="button" className="is-danger" onClick={() => deleteEnv(item)} disabled={busy || isRunning}>
                          删除
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="env-name-cell">
                        <strong>{displayName}</strong>
                        <span>{item.id || "-"}</span>
                      </div>
                    </td>
                    <td>
                      <b className={`env-badge is-${stateClass}`}>{statusText(rt)}</b>
                    </td>
                    <td>
                      <span>{sourceText(item.source)}</span>
                      <small>{item.source?.options?.resolution || ""}</small>
                    </td>
                    <td>
                      <span>{rt.marionettePort ? `:${rt.marionettePort}` : "无"}</span>
                      <small title={rt.processLabel || item.processLabel || ""}>{rt.pid ? `PID ${rt.pid}` : item.processLabel || ""}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detailActive && (
        <section className="env-detail">
          <div className="env-detail__head">
            <div>
              {currentProcessSelected ? (
                <>
                  <strong>当前主进程指纹</strong>
                  <span>{currentProcessModeText}</span>
                </>
              ) : (
                <>
                  <button type="button" className="env-name-button env-name-button--detail" title="点击重命名" onClick={e => promptRename(selected, e)}>
                    <strong>{selected.name || selected.id || "未命名环境"}</strong>
                  </button>
                  <span>{selected.id || "-"}</span>
                </>
              )}
            </div>
            <div className="env-detail__head-actions">
              {currentProcessSelected ? (
                <>
                  <button type="button" className="is-danger" onClick={resetCurrentProcessDefault} disabled={busy}>一键还原默认</button>
                </>
              ) : (
                <button type="button" onClick={e => promptRename(selected, e)} disabled={busy}>改名</button>
              )}
              {currentProcessSelected ? <b>重启生效</b> : running && <b>重开生效</b>}
            </div>
          </div>

          <div className="env-detail__summary">
            {currentProcessSelected ? (
              <>
                <span>主进程配置</span>
                <span>已写入当前 profile，重启生效</span>
                <span title={currentFingerprintPath}>{shortPath(currentFingerprintPath)}</span>
                <span title={currentProcess?.profilePath || ""}>{shortPath(currentProcess?.profilePath || "")}</span>
              </>
            ) : (
              <>
                <span title={selected.runtime?.processLabel || selected.processLabel || ""}>{selected.runtime?.processLabel || selected.processLabel || "-"}</span>
                <span>{selected.runtime?.marionettePort ? `Marionette :${selected.runtime.marionettePort}` : "Marionette -"}</span>
                <span>数据：独立 profile 保存</span>
                <span title={selected.profilePath}>{shortPath(selected.profilePath)}</span>
              </>
            )}
          </div>

          <div className="env-tabs">
            <button type="button" className={tab === "form" ? "is-active" : ""} onClick={() => setTab("form")}>指纹</button>
            <button type="button" className={tab === "import" ? "is-active" : ""} onClick={() => setTab("import")}>导入</button>
            <button type="button" className={tab === "json" ? "is-active" : ""} onClick={() => setTab("json")}>JSON</button>
          </div>

          {tab === "form" && (
            <>
              <FingerprintForm fingerprint={fingerprint} setFingerprint={setFingerprint} />
              <div className="env-detail__actions">
                <button type="button" onClick={() => saveFingerprint(false)} disabled={busy || !fingerprint}>保存指纹</button>
              </div>
            </>
          )}

          {tab === "json" && (
            <>
              <textarea className="env-json" value={fpText} onChange={e => setFpText(e.target.value)} spellCheck={false} />
              <div className="env-detail__actions">
                <button type="button" onClick={() => saveFingerprint(true)} disabled={busy}>保存 JSON</button>
              </div>
            </>
          )}

          {tab === "import" && (
            <div className="env-import">
              <div className="env-detail__actions">
                <button type="button" className="is-primary" onClick={copyCaptureScript} disabled={busy}>复制采集脚本</button>
                <button type="button" onClick={importPastedCapture} disabled={busy || !importText.trim()}>导入粘贴 JSON</button>
              </div>
              <textarea
                className="env-json env-json--import"
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder="把采集脚本在真实浏览器控制台执行后，将弹出的 JSON 粘贴到这里"
                spellCheck={false}
              />
              <p className="env-help">外部脚本只采集 JS 可见字段，导入后会规范化写入当前环境的 fingerprint.json。</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
