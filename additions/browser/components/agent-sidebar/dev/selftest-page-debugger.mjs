import assert from "node:assert/strict";

globalThis.Ci = { nsIHttpChannel: "nsIHttpChannel" };
const { PageDebugger, locateText, urlMatcher } = await import("../modules/PageDebugger.sys.mjs");

// Text location is 1-based like the Debugger API; a later occurrence can be asked for.
const source = 'var a = 1;\nfunction sign(u) {\n  const key = "k"; return hash(u + key);\n}\nsign("x");\nsign("y");';
assert.deepEqual(locateText(source, "return hash("), { index: source.indexOf("return hash("), line: 3, column: 20 });
assert.deepEqual(locateText(source, 'sign("', 2), { index: source.lastIndexOf('sign("'), line: 6, column: 1 });
assert.equal(locateText(source, "nowhere"), null);
assert.equal(urlMatcher("/api/")("https://a.test/api/sign"), true);
assert.equal(urlMatcher("*/api/sign?*")("https://a.test/api/sign?x=1"), true);
assert.equal(urlMatcher("*/api/sign?*")("https://a.test/other"), false);

// A fake engine: one source with two function scripts, breakpoints recorded instead of set.
const breakpoints = [];
const fakeSource = { text: source, startLine: 1, startColumn: 1 };
const makeScript = (name, startLine, lineCount, points) => ({
  url: "https://a.test/static/app.js", displayName: name, source: fakeSource, startLine, lineCount,
  getPossibleBreakpoints: ({ line }) => points.filter(p => p.lineNumber === line),
  setBreakpoint(offset, handler) { breakpoints.push({ script: this, offset, handler }); },
});
const outer = makeScript("top", 1, 6, [{ offset: 0, lineNumber: 1, columnNumber: 1 }, { offset: 40, lineNumber: 5, columnNumber: 1 }, { offset: 50, lineNumber: 6, columnNumber: 1 }]);
const inner = makeScript("sign", 2, 3, [{ offset: 3, lineNumber: 3, columnNumber: 3 }, { offset: 9, lineNumber: 3, columnNumber: 20 }]);
const scripts = [outer, inner];
const hooks = {};
const dbg = {
  findScripts: query => (query?.source ? scripts.filter(s => s.source === query.source) : scripts),
  addDebuggee() { hooks.added = (hooks.added || 0) + 1; },
  getNewestFrame: () => hooks.newest || null,
  clearAllBreakpoints() { hooks.cleared = true; },
  removeAllDebuggees() { hooks.removed = true; },
};
const observers = { added: [], removed: [], addObserver(o, topic) { this.added.push([o, topic]); }, removeObserver(_o, topic) { this.removed.push(topic); } };
let now = 1000;
const debuggerInstance = new PageDebugger({ createDebugger: () => dbg, observers: () => observers, requestTypes: () => new Set([11, 20]), now: () => now });
const win = {};

// Values the way Debugger hands them back: primitives, and Debugger.Object stand-ins with class/getOwnPropertyNames.
const dobj = (cls, props) => ({ class: cls, getOwnPropertyNames: () => Object.keys(props), getOwnPropertyDescriptor: name => (name in props ? { value: props[name] } : undefined) });
const env = (type, vars, parent = null, calleeScript = null) => ({ type, names: () => Object.keys(vars), getVariable: name => vars[name], parent, calleeScript });
const frameAt = (script, offset, { callee, args = [], environment = null, older = null, evalResult } = {}) => ({
  script: { ...script, getOffsetMetadata: () => ({ lineNumber: 3, columnNumber: offset === 9 ? 20 : 3 }) },
  offset, callee, arguments: args, this: dobj("Object", {}), environment, older,
  eval: code => (evalResult ? evalResult(code) : { return: true }),
});

// start: the text is found in the source, the breakpoint lands on the innermost script at the first point after the match.
assert.equal(debuggerInstance.start(null, { text: "x" }).ok, false);
assert.match(debuggerInstance.start(win, {}).error, /text|line|xhr/);
assert.match(debuggerInstance.start(win, { line: 3 }).error, /scriptUrl/);
const started = debuggerInstance.start(win, { scriptUrl: "app.js", text: "return hash(", vars: "key,u", condition: "u !== 'skip'" });
assert.equal(started.ok, true);
assert.deepEqual(started.applied, [{ url: "https://a.test/static/app.js", line: 3, column: 20, fn: "sign" }]);
assert.equal(breakpoints.length, 1);
assert.equal(breakpoints[0].script, inner);
assert.equal(breakpoints[0].offset, 9);

// hit: arguments, this, scopes with previews, deep vars found along the chain, stack, no pause.
const moduleEnv = env("object", { hash: dobj("Function", {}), table: dobj("Uint8Array", { 0: 7, 1: 8, length: 2 }) });
const callEnv = env("declarative", { u: "x", key: "k" }, moduleEnv, { displayName: "sign" });
const caller = frameAt(outer, 40, { callee: null, environment: moduleEnv });
const hit = frameAt(inner, 9, { callee: { name: "sign" }, args: ["x"], environment: callEnv, older: caller });
assert.equal(breakpoints[0].handler.hit(hit), undefined);
let q = debuggerInstance.query();
assert.deepEqual([q.armed, q.count, q.total, q.mode], [true, 1, 1, "text"]);
const first = q.hits[0];
assert.deepEqual([first.fn, first.url, first.line, first.column, first.arguments], ["sign", "https://a.test/static/app.js", 3, 20, ["x"]]);
assert.deepEqual(first.scopes.map(s => [s.type, Object.keys(s.names)]), [["declarative", ["u", "key"]], ["object", ["hash", "table"]]]);
assert.equal(first.scopes[0].names.key, "str:k");
assert.equal(first.scopes[1].names.hash, "[function anon]");
assert.deepEqual(first.vars, { key: "k", u: "x" });
assert.deepEqual(first.stack, ["sign@https://a.test/static/app.js:3:20", "top@https://a.test/static/app.js:3:3"]);

// condition: falsy skips, a throwing condition is counted, neither records a hit.
breakpoints[0].handler.hit(frameAt(inner, 9, { args: ["skip"], environment: env("declarative", { u: "skip" }), evalResult: () => ({ return: false }) }));
breakpoints[0].handler.hit(frameAt(inner, 9, { args: ["boom"], evalResult: () => ({ throw: "ReferenceError" }) }));
q = debuggerInstance.query();
assert.deepEqual([q.count, q.total, q.skippedByCondition, q.conditionErrors], [1, 3, 1, 1]);

// ring buffer keeps the last maxHits; query limit trims further.
debuggerInstance.start(win, { scriptUrl: "app.js", text: "return hash(", maxHits: 2 });
for (const u of ["a", "b", "c"]) breakpoints.at(-1).handler.hit(frameAt(inner, 9, { args: [u], environment: env("declarative", { u }) }));
assert.deepEqual(debuggerInstance.query().hits.map(h => h.arguments[0]), ["b", "c"]);
assert.deepEqual(debuggerInstance.query({ limit: 1 }).hits.map(h => h.arguments[0]), ["c"]);

// scripts compiled later (reload) get the breakpoint through onNewScript; the same source is not processed twice.
const before = breakpoints.length;
dbg.onNewScript({ source: fakeSource, url: outer.url });
assert.equal(breakpoints.length, before, "an already handled source is skipped");
const reloaded = { text: source, startLine: 1, startColumn: 1 };
scripts.push({ ...inner, source: reloaded });
dbg.onNewScript({ source: reloaded, url: outer.url });
assert.equal(breakpoints.length, before + 1, "a recompiled source gets its breakpoint back");
dbg.onNewGlobalObject({});
assert.equal(hooks.added, 1);

// line mode with a column picks the point at or after that column; inline scripts offset by startLine.
assert.deepEqual(debuggerInstance.start(win, { scriptUrl: "app.js", line: 3, column: 10 }).applied[0].column, 20);
const inlineSource = { text: "\n\nlet z = 1;\nrun(z);", startLine: 10, startColumn: 1 };
const inlineScript = makeScript("inline", 10, 4, [{ offset: 1, lineNumber: 13, columnNumber: 1 }]);
inlineScript.source = inlineSource;
inlineScript.url = "https://a.test/page.html";
scripts.push(inlineScript);
assert.deepEqual(debuggerInstance.start(win, { scriptUrl: "page.html", text: "run(z)" }).applied, [{ url: "https://a.test/page.html", line: 13, column: 1, fn: "inline" }]);

// xhr mode: the observer snapshots the newest page frame of a matching request and ignores others.
const xhr = debuggerInstance.start(win, { xhr: "*/api/sign*" });
assert.deepEqual([xhr.ok, xhr.mode, observers.added.at(-1)[1]], [true, "xhr", "http-on-opening-request"]);
const observer = observers.added.at(-1)[0];
const channel = (url, type = 11) => ({ QueryInterface() { return this; }, URI: { spec: url }, requestMethod: "POST", loadInfo: { externalContentPolicyType: type } });
hooks.newest = frameAt(inner, 9, { callee: { name: "send" }, args: [], environment: env("declarative", { body: "a=1" }) });
observer.observe(channel("https://a.test/api/sign?x=1"), "http-on-opening-request");
observer.observe(channel("https://a.test/api/sign?x=2", 3), "http-on-opening-request");
observer.observe(channel("https://a.test/static/app.js"), "http-on-opening-request");
q = debuggerInstance.query();
assert.equal(q.count, 1);
assert.deepEqual(q.hits[0].request, { url: "https://a.test/api/sign?x=1", method: "POST" });
assert.equal(q.hits[0].scopes[0].names.body, "str:a=1");

// safety valves: the time box stops everything, stop removes the observer and the breakpoints, hits stay readable.
now += 11 * 60 * 1000;
observer.observe(channel("https://a.test/api/sign?x=3"), "http-on-opening-request");
assert.equal(debuggerInstance.armed, false);
assert.deepEqual([observers.removed.at(-1), hooks.cleared, hooks.removed], ["http-on-opening-request", true, true]);
assert.deepEqual([debuggerInstance.query().armed, debuggerInstance.query().count], [false, 1]);
assert.deepEqual(debuggerInstance.stop(), { ok: true, capturedBeforeStop: 1 });

console.log("page debugger: text/line/xhr placement, snapshots, condition, ring buffer, recompiled sources, time box and stop passed");
