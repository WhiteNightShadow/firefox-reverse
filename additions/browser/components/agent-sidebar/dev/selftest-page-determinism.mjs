import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const shared = { values: new Map(), flushes: 0, set(key, value) { this.values.set(key, value); }, delete(key) { this.values.delete(key); }, get(key) { return this.values.get(key); }, flush() { this.flushes++; } };
globalThis.Services = { cpmm: { sharedData: shared } };
globalThis.JSWindowActorChild = class {};
const seededWindows = [];
globalThis.ChromeUtils = { setDeterministicRandom(win, seed) { if (win.closed) throw new Error("window gone"); seededWindows.push([win.name, seed]); } };
const written = new Map();
globalThis.IOUtils = { async makeDirectory() {}, async writeUTF8(file, text) { written.set(file, text); } };
globalThis.PathUtils = { parent: file => path.dirname(file) };
const { PageDeterminism, replicaSource } = await import("../modules/PageDeterminism.sys.mjs");
const { AgentDeterminismChild } = await import("../modules/AgentDeterminismChild.sys.mjs");

// The replica against values a seeded Firefox Reverse document produced (scripts/verify-page-interaction.mjs checks the
// live browser against this same replica): three Math.random, getRandomValues(Uint8Array(12)), randomUUID, then 50000
// more Math.random through the JIT.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frx-determinism-"));
try {
  await fs.writeFile(path.join(directory, "replica.cjs"), replicaSource());
  const { seeded } = createRequire(import.meta.url)(path.join(directory, "replica.cjs"));
  const r = seeded("frx-verify");
  assert.deepEqual([r.random(), r.random(), r.random()], [0.10097372415464634, 0.9452526114677777, 0.8470813995327754]);
  assert.deepEqual(Array.from(r.getRandomValues(new Uint8Array(12))), [215, 249, 121, 238, 165, 145, 186, 131, 20, 6, 255, 96]);
  assert.equal(r.randomUUID(), "b63094d8-50c0-4902-8241-bb3327b601e9");
  let burn = 0;
  for (let i = 0; i < 50000; i++) burn += r.random();
  assert.equal(burn, 25011.653042871345);
  // Streams are per document: a fresh seeded() starts over, and Math.random never moves the crypto stream.
  const a = seeded("frx-verify");
  const b = seeded("frx-verify");
  a.random();
  assert.equal(a.randomUUID(), b.randomUUID());
  assert.notEqual(seeded("frx-verify").random(), seeded("frx-verify2").random());
  // Typed arrays read the same bytes; empty views consume nothing; floats and oversize views are refused.
  const words = seeded("frx-verify");
  words.random();
  assert.deepEqual(Array.from(new Uint8Array(words.getRandomValues(new Uint32Array(3)).buffer)), [215, 249, 121, 238, 165, 145, 186, 131, 20, 6, 255, 96]);
  const empty = seeded("frx-verify");
  empty.getRandomValues(new Uint8Array(0));
  assert.equal(empty.getRandomValues(new Uint8Array(1))[0], 215);
  assert.throws(() => seeded("x").getRandomValues(new Float64Array(1)), TypeError);
  assert.throws(() => seeded("x").getRandomValues(new Uint8Array(65537)), RangeError);
  assert.match(seeded("签名").randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

// The parent side, against recording fakes.
const registered = [];
const actors = { registerWindowActor(name, options) { registered.push([name, options]); }, unregisterWindowActor(name) { registered.push([name, null]); } };
const queries = [];
const context = (name, { gone = false } = {}) => ({
  currentWindowGlobal: { getActor() { return { sendQuery: async (message, data) => { queries.push([name, message, data.seed]); return gone ? { ok: false } : { ok: true }; } }; } },
});
const top = { getAllBrowsingContextsInSubtree: () => [context("top"), context("frame"), { currentWindowGlobal: null }, context("dead", { gone: true })] };
const browser = { browserId: 42, browsingContext: top };
const workspace = { _resolve: file => path.join("/workspace", file) };
const determinism = new PageDeterminism({ page: { browser: () => browser }, workspace, shared: () => shared, actors, tops: id => (id === 42 || id === null ? [top] : []) });

assert.deepEqual(await determinism.run({ action: "status" }), { ok: true, active: false });
await assert.rejects(determinism.run({ action: "start", seed: "" }), /seed 不能为空/);
await assert.rejects(determinism.run({ action: "start", scope: "window" }), /scope/);
await assert.rejects(determinism.run({ action: "pause" }), /action/);
const started = await determinism.run({ action: "start", seed: "frx" });
assert.deepEqual([started.active, started.seed, started.scope, started.browserId, started.seededNow], [true, "frx", "tab", 42, 2]);
assert.deepEqual(shared.get("agentsidebar:determinism"), { seed: "frx", scope: "tab", browserId: 42 });
assert.equal(registered[0][0], "AgentDeterminism");
assert.deepEqual(registered[0][1].child.events, { DOMWindowCreated: {} });
assert.equal(registered[0][1].allFrames, true);
assert.deepEqual(queries.splice(0).map(q => q[2]), ["frx", "frx", "frx"]);

// A second start replaces the first: old documents reset, then the new seed applies to everything open.
const again = await determinism.run({ action: "start", seed: "second", scope: "all" });
assert.deepEqual([again.seed, again.browserId], ["second", null]);
assert.deepEqual(queries.splice(0).map(q => q[2]), ["", "", "", "second", "second", "second"]);
assert.deepEqual(registered.map(r => r[1] ? "register" : "unregister"), ["register", "unregister", "register"]);

const replica = await determinism.run({ action: "replica" });
assert.equal(replica.saved, "work/determinism-replica.cjs");
assert.match(replica.usage, /require\("\.\/determinism-replica\.cjs"\).*seeded\("second"\)/);
assert.equal(written.get(path.join("/workspace", "work/determinism-replica.cjs")), replicaSource());

const stopped = await determinism.run({ action: "stop" });
assert.deepEqual([stopped.active, stopped.seed, stopped.resetNow], [false, "second", 2]);
assert.equal(shared.get("agentsidebar:determinism"), undefined);
assert.deepEqual(queries.splice(0).map(q => q[2]), ["", "", ""]);
assert.equal(registered.at(-1)[1], null);
assert.deepEqual(await determinism.run({ action: "stop" }), { ok: true, active: false });

// The content side seeds a new document only when the config covers its tab.
const child = (browserId, name) => Object.assign(new AgentDeterminismChild(), { browsingContext: { browserId }, contentWindow: { name } });
shared.set("agentsidebar:determinism", { seed: "frx", scope: "tab", browserId: 42 });
child(42, "same-tab").handleEvent({ type: "DOMWindowCreated" });
child(7, "other-tab").handleEvent({ type: "DOMWindowCreated" });
child(42, "ignored-event").handleEvent({ type: "load" });
shared.set("agentsidebar:determinism", { seed: "frx", scope: "all", browserId: null });
child(7, "any-tab").handleEvent({ type: "DOMWindowCreated" });
shared.delete("agentsidebar:determinism");
child(42, "unarmed").handleEvent({ type: "DOMWindowCreated" });
assert.deepEqual(seededWindows.splice(0), [["same-tab", "frx"], ["any-tab", "frx"]]);
assert.deepEqual(child(42, "reset").receiveMessage({ name: "Determinism:Seed", data: { seed: "" } }), { ok: true });
assert.deepEqual(seededWindows.splice(0), [["reset", ""]]);
const gone = Object.assign(new AgentDeterminismChild(), { browsingContext: { browserId: 42 }, contentWindow: { closed: true } });
assert.match(gone.receiveMessage({ name: "Determinism:Seed", data: { seed: "frx" } }).error, /window gone/);

console.log("page determinism: replica matches browser values, per-document streams, start/restart/stop, replica file, tab scoping in the child passed");
