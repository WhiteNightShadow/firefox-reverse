// Offline wire tests: real HTTP requests to a loopback server enforcing Go's
// documented session/UA contract. No provider key or paid API is used.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { LlmClient, openCodeRequestHeaders } from "../modules/LlmClient.sys.mjs";
import { buildClientFromStore, fetchModels } from "../modules/providers.sys.mjs";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { ConversationStore } from "../modules/ConversationStore.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

const originalFetch = globalThis.fetch;
const originalServices = globalThis.Services;
const originalIO = globalThis.IOUtils;
const base = "https://opencode.ai/zen/go/v1";
const messages = [{ role: "user", content: "Test task" }];
const requests = [];
const cfg = new ConfigStore();
let replies = [];
const toolReply = id => ({ choices: [{ finish_reason: "tool_calls", message: {
  content: "", tool_calls: [{ id, type: "function", function: { name: "inspect", arguments: "{}" } }],
} }] });
const textReply = content => ({ choices: [{ finish_reason: "stop", message: { content } }] });

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && !req.headers["x-opencode-session"]) {
    res.statusCode = 400;
    res.end(JSON.stringify({ type: "error", error: { type: "MissingSessionID" } }));
    return;
  }
  if (req.headers["user-agent"] !== "Firefox-Reverse/test-version") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "MissingClientUserAgent" }));
    return;
  }
  if (req.method === "GET") {
    res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    return;
  }
  const reply = replies.shift();
  if (reply?.status) res.statusCode = reply.status;
  if (reply?.sse) {
    res.setHeader("content-type", "text/event-stream");
    res.end(reply.sse);
    return;
  }
  res.end(JSON.stringify(reply?.body ?? (req.url.endsWith("/messages")
    ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
    : textReply("ok"))));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

function client(protocol = "openai", sessionId = "thread-a", overrides = {}) {
  return new LlmClient({
    protocol, sessionId, baseUrl: base,
    chatPath: protocol === "anthropic" ? "/messages" : "/chat/completions",
    model: "test-model", apiKey: "offline-test-only", ...overrides,
  });
}

try {
  globalThis.Services = { prefs: { getStringPref: () => "test-version" } };
  globalThis.fetch = (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://opencode.ai");
    return originalFetch(origin + target.pathname, init);
  };

  const missing = await originalFetch(origin + "/zen/go/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "test-model", messages }),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.type, "MissingSessionID");
  console.log("PASS local gateway reproduces 400 MissingSessionID without header");
  requests.length = 0;

  for (const protocol of ["openai", "anthropic"]) {
    const c = client(protocol);
    await c.chat(messages);
    await c.chat(messages, { cacheKey: "a:projection" });
    await client(protocol).chat(messages, { cacheKey: "a:handoff" });
    assert.equal(requests.at(-1).headers["x-opencode-session"], "thread-a");
    assert.equal(requests.at(-1).headers.authorization, "Bearer offline-test-only");
    if (protocol === "anthropic") assert.equal(requests.at(-1).headers["x-api-key"], "offline-test-only");
  }
  assert(requests.every(r => r.headers["x-opencode-session"] === "thread-a"));
  console.log("PASS both protocols, auxiliary calls and recreated clients share session identity");

  await client("openai", "thread-a", { promptCacheMode: "off", model: "different-model" }).chat(messages);
  assert.equal(requests.at(-1).headers["x-opencode-session"], "thread-a");
  assert.equal(requests.at(-1).body.prompt_cache_key, undefined);
  console.log("PASS session routing is independent of prompt caching and model choice");

  await Promise.all([client("openai", "thread-a").chat(messages), client("anthropic", "thread-b").chat(messages)]);
  assert.deepEqual(new Set(requests.slice(-2).map(r => r.headers["x-opencode-session"])), new Set(["thread-a", "thread-b"]));
  await client("openai", "").chat(messages, { sessionId: "ui-fallback-thread" });
  assert.equal(requests.at(-1).headers["x-opencode-session"], "ui-fallback-thread");
  assert.throws(() => client("openai", "").buildRequest(messages), /sessionId/);
  assert.throws(() => client("openai", "bad\r\nheader").buildRequest(messages), /sessionId/);
  console.log("PASS independent conversations, UI fallback and invalid/missing session handling");

  const persisted = new Map();
  globalThis.IOUtils = {
    readJSON: async p => structuredClone(persisted.get(p)),
    writeJSON: async (p, data) => { persisted.set(p, structuredClone(data)); },
  };
  const history = new ConversationStore({ path: "/test-conversations.json", memoryOnly: false });
  const thread = await history.createThread();
  const reloaded = new ConversationStore({ path: "/test-conversations.json", memoryOnly: false });
  assert.equal((await reloaded.getThread(thread.id)).id, thread.id);
  cfg.setActiveProvider("custom");
  cfg.setCustomBaseUrl(base + "/chat/completions");
  cfg.setCustomProtocol("openai");
  cfg.setModel("custom", "test-model");
  cfg.setApiKey("custom", "offline-test-only");
  await buildClientFromStore(cfg, { sessionId: thread.id }).chat(messages);
  await buildClientFromStore(cfg, { sessionId: (await reloaded.getThread(thread.id)).id }).chat(messages);
  assert(requests.slice(-2).every(r => r.headers["x-opencode-session"] === thread.id));
  const imported = await history.importThread(await history.exportThread(thread.id));
  assert.notEqual(imported.id, thread.id);
  await buildClientFromStore(cfg, { sessionId: imported.id }).chat(messages);
  assert.equal(requests.at(-1).headers["x-opencode-session"], imported.id);
  console.log("PASS persisted thread identity survives reload; imported conversation gets its own identity");

  const beginRetries = requests.length;
  replies = [
    { status: 400, body: { error: "unsupported prompt_cache_key" } },
    { status: 503, body: { error: "temporary failure" } },
    { sse: 'data: {"choices":[{"delta":{"content":"stream ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
  ];
  const retryClient = client();
  retryClient._delay = async () => {};
  const streamed = await retryClient.chat(messages, { cacheKey: "retry", onDelta() {} });
  assert.equal(streamed.content, "stream ok");
  assert.equal(requests.length - beginRetries, 3);
  assert(requests.slice(beginRetries).every(r => r.headers["x-opencode-session"] === "thread-a"));
  assert.equal(requests[beginRetries + 1].body.prompt_cache_key, undefined);
  console.log("PASS streaming, optional-field fallback and transient retry preserve headers");

  replies = [{ sse: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic stream"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' }];
  assert.equal((await client("anthropic").chat(messages, { onDelta() {} })).content, "anthropic stream");
  console.log("PASS Anthropic streaming uses the same request identity");

  const loopStart = requests.length;
  replies = [
    { body: toolReply("tool-1") },
    { body: textReply("checkpoint") },
    { body: toolReply("tool-2") },
    { body: textReply("final summary") },
  ];
  const loopResult = await runAgentTurn({
    client: client(),
    router: { listSpecs: () => [], needsConfirm: () => false, dispatch: async () => ({ ok: true, data: "result" }) },
    messages: [...messages, { role: "assistant", content: "X".repeat(260000) }],
    maxRounds: 2, autoApprove: true, cacheKey: "loop-test", contextStrategy: "legacy",
  });
  const loopRequests = requests.slice(loopStart);
  assert.equal(loopRequests.length, 4);
  assert.equal(loopResult.content, "final summary");
  assert(loopRequests[1].body.messages[0].content.includes("交接"));
  assert(loopRequests.every(r => r.headers["x-opencode-session"] === "thread-a"));
  console.log("PASS real AgentLoop tool calls, handoff compression and final summary keep the same header");

  assert.deepEqual(await fetchModels(base, "offline-test-only"), ["test-model"]);
  assert.equal(requests.at(-1).headers["x-opencode-session"], undefined);
  assert.equal(requests.at(-1).headers["user-agent"], "Firefox-Reverse/test-version");
  console.log("PASS model discovery identifies the client without inventing a conversation");

  for (const url of ["https://opencode.ai/zen/v1/messages", base + "/chat/completions"]) {
    assert.equal(openCodeRequestHeaders(url, { sessionId: "stable" })["x-opencode-session"], "stable");
  }
  for (const url of [
    "https://api.deepseek.com/v1/chat/completions", "https://api.anthropic.com/v1/messages",
    "https://custom.example/v1/chat/completions", "https://opencode.ai.evil.example/zen/go/v1",
    "https://opencode.ai@evil.example/zen/go/v1", "https://other.example/opencode.ai/zen/go/v1",
    "http://opencode.ai/zen/go/v1", "https://opencode.ai:8443/zen/go/v1", "https://opencode.ai/docs/go/",
  ]) {
    assert.deepEqual(openCodeRequestHeaders(url, { sessionId: "thread-a" }), {});
  }
  for (const protocol of ["openai", "anthropic"]) {
    const init = client(protocol, "thread-a", { baseUrl: "https://other.example/v1" }).buildRequest(messages).init;
    assert.equal(init.headers["User-Agent"], undefined);
    assert.equal(init.headers["x-opencode-session"], undefined);
  }
  console.log("PASS only official OpenCode API endpoints receive the new headers");
  console.log("OpenCode contract selftest: all passed (local HTTP only)");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.Services = originalServices;
  globalThis.IOUtils = originalIO;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
