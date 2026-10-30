/* OpenAI Responses API protocol regression tests; no live API calls. */
import { LlmClient, PROTOCOLS, toResponsesInput } from "../modules/LlmClient.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) {
    pass++;
    console.log("  OK ", name);
  } else {
    fail++;
    console.error("  FAIL", name);
  }
}

const reasoningItem = {
  id: "rs_1",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Need inspect the page." }],
  encrypted_content: "encrypted-reasoning",
};
const assistantItem = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "I will inspect it." }],
};
const functionCallItem = {
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name: "page_info",
  arguments: '{"tab":1}',
};

const client = new LlmClient({
  protocol: PROTOCOLS.OPENAI_RESPONSES,
  baseUrl: "https://api.openai.com",
  apiKey: "test-key",
  model: "gpt-test [1m]",
  providerId: "custom",
  request: { reasoning_effort: "high", max_tokens: 1200 },
});

console.log("[1] Build Responses request and translate tool history");
const requestMessages = [
  { role: "system", content: "Act as a browser agent." },
  {
    role: "user",
    content: [
      { type: "text", text: "Inspect this page." },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "high" } },
    ],
  },
  {
    role: "assistant",
    content: "I will inspect it.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "page_info", arguments: '{"tab":1}' } }],
    responses_output: [reasoningItem, assistantItem, functionCallItem],
  },
  { role: "tool", tool_call_id: "call_1", content: "Page title: Example" },
];
const { url, init } = client.buildRequest(requestMessages, {
  stream: true,
  maxTokens: 2048,
  reasoningEffort: "xhigh",
  cacheKey: "thread-1",
  tools: [{ type: "function", function: { name: "page_info", description: "Read page", parameters: { type: "object", properties: {} } } }],
});
const body = JSON.parse(init.body);
check("endpoint uses /v1/responses", url === "https://api.openai.com/v1/responses");
check("system message becomes instructions", body.instructions === "Act as a browser agent.");
check("image input uses Responses input_image", body.input[0].content[1].type === "input_image" && body.input[0].content[1].detail === "high");
check("prior output items preserved verbatim", JSON.stringify(body.input.slice(1, 4)) === JSON.stringify([reasoningItem, assistantItem, functionCallItem]));
check("tool output is correlated by call_id", body.input[4].type === "function_call_output" && body.input[4].call_id === "call_1");
check("function tool uses flattened Responses schema", body.tools[0].name === "page_info" && body.tools[0].parameters.type === "object");
check("Responses fields use output token limit, no chat-only fields", body.max_output_tokens === 2048 && body.temperature === undefined && body.stream_options === undefined);
check("stateless reasoning round-trip is enabled", body.store === false && body.include.includes("reasoning.encrypted_content"));
check("reasoning effort and prompt cache are mapped", body.reasoning.effort === "xhigh" && body.prompt_cache_key === "thread-1");
check("reasoning summaries are requested next to the effort", body.reasoning.summary === "auto");
const plain = new LlmClient({ protocol: PROTOCOLS.OPENAI_RESPONSES, baseUrl: "https://api.openai.com", apiKey: "test-key", model: "gpt-4.1" });
const plainBody = JSON.parse(plain.buildRequest([{ role: "user", content: "hi" }]).init.body);
check("models without a reasoning setting get neither reasoning nor include", plainBody.reasoning === undefined && plainBody.include === undefined && plainBody.store === false);
const aux = JSON.parse(client.buildRequest([{ role: "user", content: "summarize" }], { auxiliary: true, maxTokens: 2048 }).init.body);
check("auxiliary calls think less and keep output headroom for the reasoning", aux.reasoning.effort === "low" && aux.max_output_tokens === 16384);

const translated = toResponsesInput([
  { role: "system", content: "first" },
  { role: "developer", content: "second" },
  { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
  { role: "assistant", content: "call", tool_calls: [{ id: "c2", function: { name: "f", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "ok" },
]);
check("assistant history uses output_text, which is all the API accepts for that role", translated.input[0].content[0].type === "output_text");
check("legacy chat tool history is translated", translated.instructions === "first\n\nsecond" && translated.input[2].type === "function_call" && translated.input[3].type === "function_call_output");

console.log("[2] Parse non-stream Responses result");
const parsed = client.parseResponse({
  status: "completed",
  output: [reasoningItem, assistantItem, functionCallItem],
  usage: { input_tokens: 12, output_tokens: 8 },
});
check("assistant text and reasoning summary are normalized", parsed.content === "I will inspect it." && parsed.reasoningContent === "Need inspect the page.");
check("function call id and arguments are normalized", parsed.toolCalls[0].id === "call_1" && parsed.toolCalls[0].function.arguments === '{"tab":1}');
check("complete response output retained", parsed.responseOutput[0].encrypted_content === "encrypted-reasoning");
check("Responses incomplete token limit maps to length", client.parseResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).finishReason === "length");

console.log("[2b] Send a non-streaming Responses request through chat()");
const originalFetch = globalThis.fetch;
let chatRequest = null;
try {
  globalThis.fetch = async (requestUrl, requestInit) => {
    chatRequest = { requestUrl, requestInit, body: JSON.parse(requestInit.body) };
    return new Response(JSON.stringify({ status: "completed", output: [assistantItem], usage: { input_tokens: 2, output_tokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const chatResult = await client.chat([{ role: "user", content: "Say hello." }]);
  check("chat() posts to Responses endpoint with bearer auth", chatRequest.requestUrl === "https://api.openai.com/v1/responses" && chatRequest.requestInit.headers.Authorization === "Bearer test-key");
  check("chat() parses a successful Responses response", chatResult.content === "I will inspect it." && chatResult.usage.output_tokens === 1);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("[3] Parse Responses SSE events");
const events = [
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Check the page." },
  { type: "response.output_item.done", output_index: 0, item: reasoningItem },
  { type: "response.output_item.added", output_index: 1, item: { ...functionCallItem, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", call_id: "call_1", delta: '{"tab":' },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", call_id: "call_1", delta: "1}" },
  { type: "response.output_item.done", output_index: 1, item: functionCallItem },
  { type: "response.output_text.delta", output_index: 2, delta: "Inspecting." },
  { type: "response.output_item.done", output_index: 2, item: assistantItem },
  { type: "response.completed", response: { status: "completed", output: [reasoningItem, functionCallItem, assistantItem], usage: { input_tokens: 3, output_tokens: 5 } } },
];
const streamText = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const encoder = new TextEncoder();
let streamedText = "";
let streamedReasoning = "";
const streamed = await client._readStreamResponses(
  new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(streamText)); controller.close(); } })),
  delta => { streamedText += delta; },
  delta => { streamedReasoning += delta; }
);
check("stream deltas reach UI callbacks", streamedText === "Inspecting." && streamedReasoning === "Check the page.");
check("stream tool call is complete", streamed.toolCalls[0].id === "call_1" && streamed.toolCalls[0].function.arguments === '{"tab":1}');
check("stream completed output retains encrypted reasoning", streamed.responseOutput[0].encrypted_content === "encrypted-reasoning");
check("stream usage and stop reason are parsed", streamed.usage.input_tokens === 3 && streamed.finishReason === "tool_calls");
const readStream = (list, onDelta = () => {}) =>
  client._readStreamResponses(
    new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(list.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); controller.close(); } })),
    onDelta,
    () => {}
  );
const bare = await readStream([
  { type: "response.output_item.added", output_index: 0, item: { ...functionCallItem, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"tab":1}' },
  { type: "response.output_item.done", output_index: 0, item: functionCallItem },
  { type: "response.output_text.delta", output_index: 1, delta: "Done." },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 5 } } },
]);
check("a completed event without output keeps the streamed text and calls", bare.content === "Done." && bare.toolCalls[0].function.arguments === '{"tab":1}' && bare.usage.input_tokens === 3 && bare.finishReason === "tool_calls");
const cut = await readStream([
  { type: "response.output_item.added", output_index: 0, item: { ...functionCallItem, arguments: "" } },
  { type: "response.output_item.added", output_index: 1, item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "env_create", arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"tab":1}' },
  { type: "response.output_item.done", output_index: 0, item: functionCallItem },
]);
check("a stream cut before a call finishes drops the unfinished call instead of running it with {}", cut.toolCalls.length === 1 && cut.toolCalls[0].id === "call_1");

console.log("[4] AgentLoop returns raw output items to the next tool round");
let turn = 0;
let rawOutputWasReturned = false;
const router = {
  listSpecs: () => [{ type: "function", function: { name: "page_info", parameters: { type: "object", properties: {} } } }],
  needsConfirm: () => false,
  dispatch: async () => ({ ok: true, data: { title: "Example" } }),
};
const mockClient = {
  model: "gpt-test",
  chat: async messages => {
    turn++;
    if (turn === 1) {
      return {
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "page_info", arguments: "{}" } }],
        responseOutput: [reasoningItem, functionCallItem],
      };
    }
    rawOutputWasReturned = messages.some(
      message => message.role === "assistant" && message.responses_output?.[0]?.encrypted_content === "encrypted-reasoning"
    );
    return { content: "## 结论\n页面已检查。", toolCalls: [], finishReason: "stop" };
  },
};
const turnResult = await runAgentTurn({
  client: mockClient,
  router,
  messages: [{ role: "user", content: "Inspect this page." }],
  systemPrompt: "Browser agent.",
  maxRounds: 2,
  assist: true,
  autoApprove: true,
});
check("AgentLoop preserves Responses output for stateless continuation", rawOutputWasReturned && turn === 2);
check("AgentLoop completes the tool round", turnResult.stopReason === "final" && turnResult.content.includes("页面已检查"));

console.log("[5] Reasoning summaries fall back when the organization is not verified");
const seen = [];
globalThis.fetch = async (_url, requestInit) => {
  const body = JSON.parse(requestInit.body);
  seen.push(body);
  if (body.reasoning?.summary) {
    return new Response('{"error":{"message":"Your organization must be verified to generate reasoning summaries."}}', { status: 400, statusText: "Bad Request" });
  }
  return new Response(JSON.stringify({ status: "completed", output: [assistantItem], usage: { input_tokens: 2, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  const result = await client.chat([{ role: "user", content: "hi" }]);
  check(
    "a rejected summary is retried without it, keeping effort and encrypted reasoning",
    result.content === "I will inspect it." && seen.length === 2 && seen[0].reasoning.summary === "auto" && seen[1].reasoning.summary === undefined && seen[1].reasoning.effort === "high" && seen[1].include.includes("reasoning.encrypted_content")
  );
  check("the rejection is remembered for this model", JSON.parse(client.buildRequest([{ role: "user", content: "hi" }]).init.body).reasoning.summary === undefined);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\nOpenAI Responses 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
