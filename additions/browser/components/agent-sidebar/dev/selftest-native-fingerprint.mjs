import assert from "node:assert/strict";
import { nativeFingerprintDefaults, validateNativeFingerprint, nativeRenderingPrefs } from "../modules/NativeFingerprintPolicy.sys.mjs";

const f = (value, enabled = true) => ({ value, enabled });
const legacy = {
  enabled: true, seed_mode: "persistent", navigator: { userAgent: f("Mozilla/5.0 Firefox/153.0"), hardwareConcurrency: f(8) },
  http: { userAgent: f("Mozilla/5.0 Firefox/153.0") }, screen: { enabled: true, width: f(1920) },
  window: { devicePixelRatio: f(2) }, webgl: { unmaskedRenderer: f("synthetic GPU") },
  canvas: { mode: f("seeded"), noise: f(0.3) }, audio: { mode: f("seeded"), seed: f("legacy") }, fonts: {},
};
const before = JSON.stringify(legacy);
validateNativeFingerprint(legacy);
assert.deepEqual(nativeRenderingPrefs(legacy), {});
assert.equal(JSON.stringify(legacy), before);
const config = nativeFingerprintDefaults(legacy, "0".repeat(64));
validateNativeFingerprint(nativeFingerprintDefaults({ enabled: true }, "0".repeat(64)));
validateNativeFingerprint(config);
assert.deepEqual(nativeFingerprintDefaults(config, "0".repeat(64)), config);
assert.equal(config.screen.width.enabled, false);
assert.equal(config.window.devicePixelRatio.enabled, false);
assert.equal(config.webgl.unmaskedRenderer.enabled, false);
assert.equal(config.navigator.hardwareConcurrency.enabled, false);
assert.equal(JSON.stringify(legacy), before);
assert.equal(config.audio.seed.enabled, false);
assert.equal(nativeRenderingPrefs(config)["media.cubeb.force_sample_rate"], 0);

const edit = fn => { const next = structuredClone(config); fn(next); return next; };
const software = edit(c => { c.canvas.backend = f("software"); c.webgl.msaaSamples = f(0); });
assert.equal(nativeRenderingPrefs(software)["gfx.canvas.accelerated"], false);
assert.equal(nativeRenderingPrefs(software)["gfx.canvas.azure.backends"], "skia");
assert.equal(nativeRenderingPrefs(software)["gfx.canvas.accelerated.force-enabled"], false);
assert.equal(nativeRenderingPrefs(software)["webgl.msaa-samples"], 0);
software.enabled = false;
assert.equal(nativeRenderingPrefs(software)["gfx.canvas.accelerated"], true);
assert.equal(nativeRenderingPrefs(software)["webgl.msaa-samples"], 4);
const seeded = edit(c => { c.audio.mode = f("seeded"); c.audio.seed.enabled = true; });
validateNativeFingerprint(seeded);
for (const name of ["sampleRate", "noise", "baseLatency", "outputLatency"]) {
  const bad = structuredClone(seeded);
  bad.audio[name] = f(0);
  assert.throws(() => validateNativeFingerprint(bad), /conflicts/);
  bad.audio[name].enabled = false;
  validateNativeFingerprint(bad);
}
for (const seed of ["0".repeat(32), "0".repeat(63) + "g", "", null]) {
  const bad = structuredClone(seeded); bad.audio.seed = f(seed);
  assert.throws(() => validateNativeFingerprint(bad), /64-hex/);
}
const allowlist = edit(c => { c.fonts.mode = f("allowlist"); c.fonts.families = f(["Arial", "Noto Sans"]); });
validateNativeFingerprint(allowlist, { installedFonts: ["Arial", "Noto Sans"] });
assert.throws(() => validateNativeFingerprint(allowlist, { installedFonts: ["Arial"] }), /not installed/);
assert.equal(nativeRenderingPrefs(allowlist)["font.system.whitelist"], "Arial,Noto Sans");
assert.equal(nativeRenderingPrefs(allowlist)["gfx.e10s.font-list.shared"], false);
allowlist.fonts.mode = f("native"); allowlist.fonts.families.enabled = false;
assert.equal(nativeRenderingPrefs(allowlist)["font.system.whitelist"], "");
assert.equal(nativeRenderingPrefs(allowlist)["gfx.e10s.font-list.shared"], true);
for (const names of [[], ["Arial", "arial"], ["Arial,Calibri"], [" Arial"], ["\u0000Arial"]]) {
  assert.throws(() => validateNativeFingerprint(edit(c => { c.fonts.mode = f("allowlist"); c.fonts.families = f(names); })));
}
for (const mutate of [
  c => { c.screen.enabled = true; c.screen.width.enabled = true; },
  c => { c.devicePixelRatio = f(2); },
  c => { c.webgl.unmaskedRenderer.enabled = true; },
  c => { c.webgl.msaaSamples = f(8); },
  c => { c.canvas.mode = f("seeded"); },
  c => { c.canvas.noise = f(0); },
  c => { c.http.userAgent = f("Chrome/150.0"); },
  c => { c.navigator.userAgent.enabled = true; c.http.userAgent = f("Firefox/152.0"); },
  c => { c.navigator.userAgentData = f({}); },
  c => { c.consistency.version = 2; },
  c => { c.audio.enabled = "true"; },
]) assert.throws(() => validateNativeFingerprint(edit(mutate)));
console.log("Native fingerprint policy selftest passed: legacy preservation, display/GPU gating, real prefs, reset, fonts, audio seeds");
