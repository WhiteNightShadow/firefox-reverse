import assert from "node:assert/strict";

globalThis.Ci = { nsIHttpChannel: "nsIHttpChannel" };
globalThis.Cr = { NS_ERROR_CONNECTION_REFUSED: 0x804b000d };
const { NetworkReplay, requestKey, bytesFromText, textFromBytes, entriesFromHar, harFromEntries } = await import("../modules/NetworkReplay.sys.mjs");

// Keys: method + URL without fragment, query compared as asked, body hashed when it takes part.
const feed = { method: "get", url: "https://a.test/api?b=2&a=1#frag" };
assert.equal(requestKey(feed), "GET https://a.test/api?b=2&a=1 ");
assert.equal(requestKey(feed, { query: "ignore-order" }), "GET https://a.test/api?a=1&b=2 ");
assert.equal(requestKey(feed, { query: "ignore" }), "GET https://a.test/api ");
const sign = body => ({ method: "POST", url: "https://a.test/sign", body });
assert.notEqual(requestKey(sign("x=1")), requestKey(sign("x=2")));
assert.equal(requestKey(sign("x=1"), { matchBody: false }), requestKey(sign("x=2"), { matchBody: false }));

// Bodies are byte strings: one char per byte, as nsIReplacedHttpResponse.responseBody takes them.
const chinese = bytesFromText("签名 ok");
assert.equal(chinese.length, 9);
assert.equal(textFromBytes(chinese), "签名 ok");

// HAR round trip keeps method, URL, status, request and response bytes (binary through base64).
const recorded = [
  { id: "capture:1", t: 0, method: "POST", url: "https://a.test/sign", requestBody: bytesFromText('{"a":1}'), requestHeaders: [["Content-Type", "application/json"]],
    status: 200, statusText: "OK", headers: [["Content-Type", "application/json"], ["Content-Encoding", "gzip"]], body: bytesFromText('{"sig":"中"}') },
  { id: "capture:2", t: 0, method: "GET", url: "https://a.test/pixel.gif", requestBody: null, requestHeaders: [],
    status: 200, statusText: "OK", headers: [["Content-Type", "image/gif"]], body: "GIF89a\x00\xff\x80" },
];
const back = entriesFromHar(JSON.parse(JSON.stringify(harFromEntries(recorded, "153.0a1"))));
const shape = entries => entries.map(e => [e.method, e.url, e.status, e.statusText, e.body, e.requestBody]);
assert.deepEqual(shape(back), shape(recorded));
assert.deepEqual(back[0].headers, recorded[0].headers);
const plain = entriesFromHar({ log: { entries: [
  { request: { method: "GET", url: "https://a.test/x" }, response: { status: 404, statusText: "Not Found", headers: [], content: { text: "缺" } } },
  { request: { url: "https://a.test/no-body" }, response: { status: 200, content: {} } },
] } });
assert.equal(plain.length, 1);
assert.deepEqual([plain[0].status, textFromBytes(plain[0].body)], [404, "缺"]);

// The engine, against observers and channels that only record.
const observers = { added: [], removed: [], addObserver(_o, topic) { this.added.push(topic); }, removeObserver(_o, topic) { this.removed.push(topic); } };
const served = [];
const replay = new NetworkReplay({ observers: () => observers, override: (channel, entry) => served.push(entry.id), uploadBody: channel => channel.body });
const channel = (url, { method = "GET", top = 7, body = null } = {}) => ({
  URI: { spec: url }, requestMethod: method, body, cancelled: null, loadInfo: { browsingContext: { browserId: top } },
  QueryInterface() { return this; },
  cancel(code) { this.cancelled = code; },
});
const send = ch => { replay.observe(ch, "http-on-modify-request"); return ch; };
const recordings = [
  { id: "r1", method: "GET", url: "https://a.test/feed?page=1", headers: [], status: 200, body: "one" },
  { id: "r2", method: "GET", url: "https://a.test/feed?page=1", headers: [], status: 200, body: "two" },
  { id: "r3", method: "POST", url: "https://a.test/sign", requestBody: "x=1", headers: [], status: 200, body: "signed" },
];
assert.throws(() => replay.start({ entries: recordings }), /需要当前标签页/);
assert.throws(() => replay.start({ entries: recordings, browserId: 7, query: "fuzzy" }), /query/);
const started = replay.start({ entries: recordings, browserId: 7 });
assert.deepEqual([started.entries, started.keys, observers.added], [3, 2, ["http-on-modify-request"]]);
for (let i = 0; i < 3; i++) send(channel("https://a.test/feed?page=1"));
assert.deepEqual(served.splice(0), ["r1", "r2", "r2"], "recorded order, then the last recording keeps answering");
send(channel("https://a.test/sign", { method: "POST", body: "x=1" }));
assert.deepEqual(served.splice(0), ["r3"]);
assert.equal(send(channel("https://a.test/sign", { method: "POST", body: "x=2" })).cancelled, Cr.NS_ERROR_CONNECTION_REFUSED, "an unrecorded body is blocked");
assert.equal(send(channel("https://a.test/feed?page=1", { top: 9 })).cancelled, null, "another tab is left alone");
assert.deepEqual(served.splice(0), []);
assert.deepEqual([replay.status().replayed, replay.status().blocked, replay.status().passed], [4, 1, 0]);
assert.deepEqual(replay.log().map(d => d.decision), ["replayed", "replayed", "replayed", "replayed", "blocked"]);

replay.start({ entries: recordings, browserId: 7, reuse: false, unmatched: "pass" });
assert.deepEqual(observers.removed, ["http-on-modify-request"], "a new start replaces the old observer");
const third = [0, 1, 2].map(() => send(channel("https://a.test/feed?page=1")));
assert.deepEqual(served.splice(0), ["r1", "r2"]);
assert.equal(third[2].cancelled, null, "reuse=false lets the third request through when unmatched=pass");
assert.equal(replay.status().passed, 1);

replay.start({ entries: recordings, scope: "all", query: "ignore" });
send(channel("https://a.test/feed?page=2", { top: 9 }));
assert.deepEqual(served.splice(0), ["r1"], "scope=all and query=ignore answer any tab and query");
assert.equal(replay.stop().replayed, 1);
send(channel("https://a.test/feed?page=1"));
assert.deepEqual(served, [], "nothing is answered after stop");
assert.deepEqual(replay.status(), { replaying: false });

console.log("network replay: keys, byte strings, HAR round trip, recorded order, reuse, unmatched block/pass, tab scope and stop passed");
