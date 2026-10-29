import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { NativeInput, PageInteractionCore, keyFor } from "../modules/PageInteractionCore.sys.mjs";
import { PageInteractionBackend } from "../modules/PageInteractionBackend.sys.mjs";

const dom = new JSDOM(`<!doctype html><title>Fixture</title>
  <button id="go" aria-labelledby="caption">X</button><span id="caption">Continue</span>
  <label id="account-label" for="input">Account</label><input id="input"><input type="password" value="private-secret" aria-label="Password">
  <button hidden>Invisible</button><button disabled>Disabled</button>
  <button>Duplicate</button><button>Duplicate</button><div id="shadow"></div>
  <button id="covered">Covered</button><div id="overlay" class="modal backdrop"></div>
  <ul><li id="long">Alpha beta</li></ul><span id="short">Alpha</span><textarea id="notes"></textarea>`, { pretendToBeVisual: true, url: "https://fixture.invalid/" });
const { window: win } = dom;
const box = { x: 1, y: 2, left: 1, top: 2, right: 41, bottom: 22, width: 40, height: 20 };
win.HTMLElement.prototype.getClientRects = function() { return this.hidden ? [] : [box]; };
win.HTMLElement.prototype.scrollIntoView = function() {};
const $ = selector => win.document.querySelector(selector);
// Hit-testing answers with whatever the test puts on top.
let onTop = null;
win.document.elementFromPoint = () => onTop;

// Stands in for NativeInput: records the gestures the core asks for and applies their visible effect.
const gestures = [];
const input = {
  random: () => 0.5,
  async move(x, y) { gestures.push(["move", x, y]); },
  async press(x, y) {
    gestures.push(["press", x, y]);
    const target = win.document.elementFromPoint(x, y);
    target.focus?.();
    target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  },
  async click(x, y) { gestures.push(["click", x, y]); },
  async type(text, options) {
    gestures.push(["type", text, options]);
    win.document.activeElement.value = text;
  },
  async key(name) {
    gestures.push(["key", name]);
    if (name === "Backspace") win.document.activeElement.value = "";
  },
};
const core = new PageInteractionCore(win, input);
const scan = core.scan();
assert.equal(scan.elements.length, 8);
assert.ok(!JSON.stringify(scan).includes("private-secret"));
assert.equal(core.scan({ role: "button", name: "Continue" }).elements.length, 1);
assert.equal(core.scan({ label: "Account" }).elements.length, 1);
assert.equal(core.scan({ name: "Invisible" }).elements.length, 0);
await assert.rejects(() => core.act("click", { role: "button", name: "Duplicate" }), /ambiguous_target/);
await assert.rejects(() => core.act("click", { name: "Disabled" }), /target_disabled/);
assert.throws(() => core.scan({ selector: "[" }), /not a valid selector/);
assert.throws(() => core.scan({ name: "x".repeat(2001) }), /invalid_locator/);
assert.equal(core.scan({ limit: 1 }).truncated, true);
assert.equal(core.scan({ maxNodes: 1 }).truncated, true);
await assert.rejects(() => core.act("click", { name: "Continue", maxNodes: 1 }), /incomplete_search/);

// A click travels to a point the element owns, then presses there.
let clicked = 0;
$("#go").addEventListener("click", () => clicked++);
const ref = core.scan({ name: "Continue" }).elements[0].id;
onTop = $("#go");
const click = await core.act("click", { id: ref });
assert.equal(clicked, 1);
assert.deepEqual(gestures.splice(0), [["move", 21, 12], ["press", 21, 12]]);
assert.deepEqual([click.x, click.y], [21, 12]);

// Something else on top: refuse instead of pressing the overlay.
let coveredClicks = 0;
$("#covered").addEventListener("click", () => coveredClicks++);
onTop = $("#overlay");
await assert.rejects(() => core.act("click", { selector: "#covered" }), /target_obscured: covered by div#overlay\.modal\.backdrop/);
assert.equal(coveredClicks, 0);
assert.deepEqual(gestures.splice(0), []);

// Typing focuses the field with a press (a label drawn over it counts), replaces its text, then submits.
onTop = $("#account-label");
const typed = await core.act("type", { label: "Account", text: "value-not-a-locator", submit: true });
assert.equal($("#input").value, "value-not-a-locator");
assert.deepEqual(typed, { ok: true, filled: true, length: 19, valueMatches: true, submitted: true });
assert.deepEqual(gestures.splice(0).map(([kind, , options]) => kind === "type" ? [kind, options] : kind), ["move", "press", ["type", { delayMs: 60, multiline: false }], "key"]);
await core.act("type", { label: "Account", text: "" });
assert.equal($("#input").value, "");
assert.deepEqual(gestures.splice(0), [["key", "Backspace"]]);
await core.act("type", { selector: "#notes", text: "x".repeat(500), delayMs: 300 });
assert.deepEqual(gestures.splice(0).find(([kind]) => kind === "type")[2], { delayMs: 20, multiline: true });
await assert.rejects(() => core.act("type", { selector: "#notes", text: "x".repeat(2001) }), /text_too_long/);

// The old selector/text contract: shortest exact text first, then partial; selector misses are reported.
onTop = $("#short");
await core.act("click", { text: "Alpha", legacy: true });
assert.equal(gestures.splice(0).length, 2);
onTop = $("#long");
assert.equal((await core.act("click", { text: "beta", legacy: true })).text, "Alpha beta");
gestures.splice(0);
await assert.rejects(() => core.act("click", { selector: "#missing", legacy: true }), /target_not_found/);
onTop = $("#input");
await core.act("type", { selector: "#input", text: "legacy", legacy: true });
assert.equal($("#input").value, "legacy");
await assert.rejects(() => core.act("type", { selector: "#missing", text: "x", legacy: true }), /target_not_found/);
gestures.splice(0);

$("#go").remove();
await assert.rejects(() => core.act("click", { id: ref }), /stale_ref/);
const shadow = $("#shadow").attachShadow({ mode: "open" });
shadow.innerHTML = "<button>Shadow action</button>";
assert.equal(core.scan({ name: "Shadow action" }).elements.length, 1);
await assert.rejects(() => core.act("click", { x: -1, y: 1 }), /invalid_coordinates/);
await assert.rejects(() => core.act("click", { x: 1, y: 1, id: ref }), /ambiguous_locator/);
onTop = $("#input");
await assert.rejects(() => core.act("click", { x: 10, y: 20 }), /coordinate_input_unavailable/);
win.synthesizeMouseEvent = () => {};
await core.act("click", { x: 10, y: 20 });
assert.deepEqual(gestures.splice(0), [["click", 10, 20]]);
onTop = win.document.createElement("iframe");
await assert.rejects(() => core.act("click", { x: 1, y: 1 }), /frame_target/);

// NativeInput itself, against a window and text input processor that only record.
assert.deepEqual(keyFor("a"), { key: "a", code: "KeyA", keyCode: 65, shift: false });
assert.deepEqual(keyFor("Z"), { key: "Z", code: "KeyZ", keyCode: 90, shift: true });
assert.deepEqual(keyFor(")"), { key: ")", code: "Digit0", keyCode: 48, shift: true });
assert.deepEqual(keyFor("-"), { key: "-", code: "Minus", keyCode: 173, shift: false });
assert.deepEqual(keyFor("_"), { key: "_", code: "Minus", keyCode: 173, shift: true });
assert.deepEqual(keyFor(" "), { key: " ", code: "Space", keyCode: 32, shift: false });
assert.equal(keyFor("中"), null);
assert.equal(keyFor("\t"), null);
const mouse = [];
const keys = [];
const waits = [];
const fakeWindow = {
  innerWidth: 800,
  innerHeight: 600,
  synthesizeMouseEvent: (type, x, y, data, options) => mouse.push({ type, x, y, clickCount: data.clickCount, options }),
  KeyboardEvent: class { constructor(_type, init) { Object.assign(this, init); } },
};
const tip = {
  beginInputTransactionForTests: () => true,
  keydown: (event, flags) => keys.push(["down", event.key, event.code, event.keyCode, flags ?? 0]),
  keyup: (event, flags) => keys.push(["up", event.key, flags ?? 0]),
  commitCompositionWith: text => keys.push(["commit", text]),
};
const native = new NativeInput(fakeWindow, { wait: async ms => waits.push(ms), random: () => 0.5, createTip: () => tip, nonPrintableFlag: 7 });
native.pointer = { x: 10, y: 10 };
await native.click(400, 300, 30);
const moves = mouse.filter(event => event.type === "mousemove");
assert.ok(moves.length >= 4, "the pointer travels in several steps");
assert.deepEqual(moves.at(-1), { type: "mousemove", x: 400, y: 300, clickCount: 0, options: { toWindow: true, isDOMEventSynthesized: false } });
assert.ok(moves.every(event => event.x >= 0 && event.x < 800 && event.y >= 0 && event.y < 600));
assert.deepEqual(mouse.slice(-2).map(event => [event.type, event.x, event.y, event.clickCount]), [["mousedown", 400, 300, 1], ["mouseup", 400, 300, 1]]);
assert.deepEqual(native.pointer, { x: 400, y: 300 });
assert.ok(waits.length > moves.length && waits.every(ms => ms >= 0));
await native.type("aB中文!\n", { delayMs: 10 });
assert.deepEqual(keys.splice(0), [
  ["down", "a", "KeyA", 65, 0], ["up", "a", 0],
  ["down", "Shift", "ShiftLeft", 16, 7], ["down", "B", "KeyB", 66, 0], ["up", "B", 0], ["up", "Shift", 7],
  ["commit", "中文"],
  ["down", "Shift", "ShiftLeft", 16, 7], ["down", "!", "Digit1", 49, 0], ["up", "!", 0], ["up", "Shift", 7],
]);
await native.type("x\ny", { delayMs: 0, multiline: true });
assert.deepEqual(keys.splice(0).map(entry => entry.slice(0, 2)), [["down", "x"], ["up", "x"], ["down", "Enter"], ["up", "Enter"], ["down", "y"], ["up", "y"]]);
await native.key("Enter");
assert.deepEqual(keys.splice(0), [["down", "Enter", "Enter", 13, 7], ["up", "Enter", 7]]);
const busy = new NativeInput(fakeWindow, { wait: async () => {}, createTip: () => ({ beginInputTransactionForTests: () => false }) });
await assert.rejects(() => busy.type("x"), /input_busy/);
await assert.rejects(() => new NativeInput({}, { wait: async () => {} }).click(1, 1), /native_input_unavailable/);

globalThis.Services = { uuid: { generateUUID: randomUUID } };
globalThis.ChromeUtils = { registerWindowActor() {} };
const makeFrame = (id, parent = null) => ({ id, parent, children: [], currentWindowGlobal: {
  innerWindowId: id + 100, documentURI: { spec: `https://frame${id}.invalid` }, documentPrincipal: { isSystemPrincipal: false }, getActor() { return { frame: id }; },
} });
const top = makeFrame(1);
const child = makeFrame(2, top);
const nested = makeFrame(3, child);
top.children.push(child);
child.children.push(nested);
const calls = [];
const backend = new PageInteractionBackend(async (actor, _name, data) => {
  calls.push({ actor, data });
  return data.action === "snapshot" || data.action === "find" ? { ok: true, title: "frame", elements: [{ id: "1", name: "Button", role: "button" }], truncated: false } : { ok: true };
}, () => ({ browsingContext: top }));
assert.deepEqual(backend.frames({}).frames.map(f => f.parentId), [null, "1", "2"]);
const snapshot = await backend.scan("snapshot", { frameId: "all" });
assert.equal(snapshot.count, 3);
assert.equal(snapshot.partial, false);
assert.equal((await backend.scan("snapshot", { frameId: "all", limit: 1 })).truncated, true);
await backend.act("click", { ref: snapshot.elements[2].ref });
assert.equal(calls.at(-1).actor.frame, 3);
await backend.act("type", { ref: snapshot.elements[2].ref, text: "secret" });
assert.equal(calls.at(-1).data.text, "secret");
await backend.act("click", { selector: "#go", legacy: true });
assert.deepEqual([calls.at(-1).actor.frame, calls.at(-1).data.legacy], [1, true]);
await assert.rejects(() => backend.act("click", { ref: snapshot.elements[2].ref, name: "other" }), /ambiguous_locator/);
await assert.rejects(() => backend.act("click", { ref: snapshot.elements[2].ref, frameId: "2" }), /ref_frame_mismatch/);
await assert.rejects(() => backend.act("click", { frameId: "all", name: "Button" }), /frame_not_found/);
nested.currentWindowGlobal.innerWindowId++;
await assert.rejects(() => backend.act("click", { ref: snapshot.elements[2].ref }), /stale_ref/);
top.currentWindowGlobal.innerWindowId++;
await assert.rejects(() => backend.act("click", { ref: snapshot.elements[0].ref }), /stale_ref/);
const unknownBackend = new PageInteractionBackend(backend.query, backend.browser);
await assert.rejects(() => unknownBackend.act("click", { ref: snapshot.elements[0].ref }), /stale_ref/);
assert.notEqual(backend.epoch, unknownBackend.epoch);
child.currentWindowGlobal.documentPrincipal.isSystemPrincipal = true;
assert.equal((await backend.scan("snapshot", { frameId: "all" })).partial, true);
await assert.rejects(() => backend.act("click", { frameId: "2", selector: "button" }), /unsupported_document/);
const controller = new AbortController();
controller.abort();
await assert.rejects(() => backend.scan("snapshot", {}, { signal: controller.signal }), /cancelled/);
dom.window.close();
console.log("page interaction: semantic and legacy locators, hit-tested native gestures, typing pace, key map, frame routing and stale references passed");
