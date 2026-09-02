import { LlmClient } from "../modules/LlmClient.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};

const messages = [{ role: "system", content: "stable" }, { role: "user", content: "hi" }];
const custom = new LlmClient({
  protocol: "openai",
  providerId: "custom",
  baseUrl: "https://api.openai.com",
  apiKey: "k",
  model: "gpt-test",
  promptCacheMode: "auto",
});
let built = custom.buildRequest(messages, { cacheKey: "thread:model:v1", maxTokens: 1234 });
let body = JSON.parse(built.init.body);
ok(built.cacheApplied && body.prompt_cache_key === "thread:model:v1", "custom OpenAI request carries cache key");
ok(body.max_tokens === 1234, "per-call maxTokens is honored");

const deepseek = new LlmClient({
  protocol: "openai",
  providerId: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "k",
  model: "deepseek-v4-flash",
});
body = JSON.parse(deepseek.buildRequest(messages, { cacheKey: "same" }).init.body);
ok(body.prompt_cache_key === undefined, "DeepSeek uses automatic cache without unsupported fields");
body = JSON.parse(deepseek.buildRequest(messages, { cacheKey: "same", stream: true }).init.body);
ok(body.stream_options?.include_usage === true, "OpenAI-compatible streams request final usage counters");

const anthropic = new LlmClient({
  protocol: "anthropic",
  providerId: "custom",
  baseUrl: "https://api.anthropic.com",
  apiKey: "k",
  model: "claude-test",
  promptCacheMode: "auto",
  promptCacheTtl: "1h",
});
built = anthropic.buildRequest(messages, { cacheKey: "thread:model:v1" });
body = JSON.parse(built.init.body);
ok(body.cache_control?.type === "ephemeral" && body.cache_control?.ttl === "1h", "Anthropic native cache control is applied");

const oldFetch = globalThis.fetch;
const seenBodies = [];
let calls = 0;
globalThis.fetch = async (_url, init) => {
  seenBodies.push(JSON.parse(init.body));
  calls++;
  if (calls === 1) {
    return new Response('{"error":"unknown prompt_cache_key"}', { status: 400, statusText: "Bad Request" });
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  const result = await custom.chat([{ role: "user", content: "retry" }], { cacheKey: "fallback" });
  ok(result.content === "ok" && calls === 2, "cache-field 4xx retries once without failing the chat");
  ok(seenBodies[0].prompt_cache_key && seenBodies[1].prompt_cache_key === undefined, "fallback removes rejected cache field");
  body = JSON.parse(custom.buildRequest(messages, { cacheKey: "later" }).init.body);
  ok(body.prompt_cache_key === undefined, "client remembers incompatible gateway");
  const nextClient = new LlmClient({
    protocol: "openai",
    providerId: "custom",
    baseUrl: "https://api.openai.com",
    apiKey: "k",
    model: "gpt-test",
  });
  body = JSON.parse(nextClient.buildRequest(messages, { cacheKey: "later" }).init.body);
  ok(body.prompt_cache_key === undefined, "endpoint compatibility survives client recreation");
} finally {
  globalThis.fetch = oldFetch;
}

let streamCalls = 0;
const streamBodies = [];
globalThis.fetch = async (_url, init) => {
  streamBodies.push(JSON.parse(init.body));
  streamCalls++;
  if (streamCalls === 1) {
    return new Response('{"error":"unknown stream_options"}', { status: 400, statusText: "Bad Request" });
  }
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}',
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};
try {
  const streamClient = new LlmClient({
    protocol: "openai",
    providerId: "zhipu",
    baseUrl: "https://stream-compat.example.com/v1",
    apiKey: "k",
    model: "m",
  });
  let delta = "";
  const streamResult = await streamClient.chat([{ role: "user", content: "hi" }], {
    onDelta: chunk => { delta += chunk; },
  });
  ok(streamCalls === 2 && delta === "ok" && streamResult.content === "ok", "stream_options 4xx retries and preserves streaming output");
  ok(streamBodies[0].stream_options?.include_usage === true && streamBodies[1].stream_options === undefined, "stream compatibility fallback removes only optional request field");
  ok(streamResult.usage?.prompt_tokens === 12, "stream usage survives compatibility fallback");
} finally {
  globalThis.fetch = oldFetch;
}

console.log(`\nPrompt cache selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
