/* Gemini GenerateContent protocol regression tests; no live API calls. */
import { LlmClient, PROTOCOLS, toGeminiRequest } from "../modules/LlmClient.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";
import { createBuiltinTools } from "../modules/Tools.sys.mjs";

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

const client = new LlmClient({
  protocol: PROTOCOLS.GEMINI,
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "test-key",
  model: "gemini-2.5-flash",
  request: { max_tokens: 2048, temperature: 0.3 },
});
const tool = {
  type: "function",
  function: {
    name: "inspect_page",
    description: "Inspect a browser page",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { tab: { type: "integer", description: "Tab id", examples: [1] } },
      required: ["tab"],
      additionalProperties: false,
    },
  },
};

console.log("[1] Build Gemini native request");
const built = client.buildRequest(
  [
    { role: "system", content: "You are a browser agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this page." },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    },
  ],
  { tools: [tool], maxTokens: 1600 }
);
const body = JSON.parse(built.init.body);
check(
  "uses native model generateContent endpoint",
  built.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
);
check(
  "uses Google API key header without Bearer auth",
  built.init.headers["x-goog-api-key"] === "test-key" && built.init.headers.Authorization === undefined
);
check("system prompt becomes systemInstruction", body.systemInstruction.parts[0].text === "You are a browser agent.");
check("user text and image become Gemini parts", body.contents[0].parts[0].text === "Inspect this page." && body.contents[0].parts[1].inlineData.mimeType === "image/png");
check("generation settings use Gemini field names", body.generationConfig.maxOutputTokens === 1600 && body.generationConfig.temperature === 0.3);
const declaration = body.tools[0].functionDeclarations[0];
check(
  "function declarations send standard JSON Schema through parametersJsonSchema",
  declaration.parameters === undefined && declaration.parametersJsonSchema.type === "object" &&
    declaration.parametersJsonSchema.properties.tab.type === "integer" && declaration.parametersJsonSchema.additionalProperties === false
);
check("keywords Gemini does not list are removed", declaration.parametersJsonSchema.$schema === undefined && declaration.parametersJsonSchema.properties.tab.examples === undefined);
check("thought summaries are requested without touching the thinking budget", body.generationConfig.thinkingConfig.includeThoughts === true && body.generationConfig.thinkingConfig.thinkingBudget === undefined);
const aux = JSON.parse(client.buildRequest([{ role: "user", content: "summarize" }], { auxiliary: true, maxTokens: 2048 }).init.body);
check("auxiliary calls skip thought summaries and get output headroom", aux.generationConfig.thinkingConfig === undefined && aux.generationConfig.maxOutputTokens === 8192);
const unlimited = new LlmClient({ protocol: PROTOCOLS.GEMINI, baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", model: "gemini-2.5-flash" });
check("auxiliary calls without a configured limit keep the model default", JSON.parse(unlimited.buildRequest([{ role: "user", content: "hi" }], { auxiliary: true }).init.body).generationConfig.maxOutputTokens === undefined);

console.log("[1b] Every builtin tool becomes a valid Gemini function declaration");
const anyBackend = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => {} }) });
const specs = createBuiltinTools(anyBackend);
const declarations = JSON.parse(client.buildRequest([{ role: "user", content: "hi" }], { tools: specs }).init.body).tools[0].functionDeclarations;
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const JSON_KEYS = new Set(["type", "title", "description", "properties", "required", "additionalProperties", "enum", "format", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf"]);
const problems = [];
function validateSchema(node, path) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return problems.push(`${path}: not a schema object`);
  for (const key of Object.keys(node)) if (!JSON_KEYS.has(key)) problems.push(`${path}: keyword ${key}`);
  if (node.type === undefined && !node.anyOf && !node.oneOf && !node.enum) problems.push(`${path}: no type`);
  for (const type of Array.isArray(node.type) ? node.type : [node.type]) if (type !== undefined && !JSON_TYPES.has(type)) problems.push(`${path}: type ${type}`);
  for (const [name, sub] of Object.entries(node.properties || {})) validateSchema(sub, `${path}.${name}`);
  for (const name of node.required || []) if (!node.properties?.[name]) problems.push(`${path}: required ${name} is not a property`);
  if (node.items && !Array.isArray(node.items)) validateSchema(node.items, `${path}[]`);
  for (const sub of [...(node.anyOf || []), ...(node.oneOf || [])]) validateSchema(sub, path);
}
for (const d of declarations) {
  if (!d.name || typeof d.description !== "string") problems.push(`${d.name}: name or description missing`);
  if (d.parameters !== undefined) problems.push(`${d.name}: OpenAPI parameters field`);
  if (d.parametersJsonSchema !== undefined) {
    if (d.parametersJsonSchema.type !== "object") problems.push(`${d.name}: root is not an object`);
    validateSchema(d.parametersJsonSchema, d.name);
  }
}
check(`all ${specs.length} builtin tools are declared without problems${problems.length ? ": " + problems.slice(0, 3).join("; ") : ""}`, declarations.length === specs.length && problems.length === 0);
check("tools without parameters omit the schema", declarations.filter(d => d.parametersJsonSchema === undefined).map(d => d.name).includes("page_info"));
const jsTrace = declarations.find(d => d.name === "js_trace").parametersJsonSchema;
const envWrite = declarations.find(d => d.name === "env_write_config").parametersJsonSchema;
check("arrays without items and free-form objects survive as JSON Schema", jsTrace.properties.entryArgs.type === "array" && jsTrace.properties.entryArgs.items === undefined && envWrite.properties.config.type === "object");

const oldTemplateClient = new LlmClient({
  protocol: PROTOCOLS.GEMINI,
  baseUrl: "https://generativelanguage.googleapis.com",
  chatPath: "/v1beta/models/{model}:generateContent",
  apiKey: "test-key",
  model: "gemini-2.5-flash",
});
check(
  "agent.json model path template supports stream endpoint",
  oldTemplateClient.buildRequest([{ role: "user", content: "hi" }], { stream: true }).url ===
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
);

console.log("[2] Parse Gemini response and stateless tool history");
const responseContent = {
  role: "model",
  parts: [
    { text: "Inspecting." },
    { functionCall: { id: "call-id-1", name: "inspect_page", args: { tab: 1 } }, thoughtSignature: "keep-this-signature" },
  ],
};
const parsed = client.parseResponse({
  candidates: [{ content: responseContent, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3 },
});
check("text and function call normalize", parsed.content === "Inspecting." && parsed.toolCalls[0].function.name === "inspect_page");
check("Google usage counts thoughts as output", parsed.usage.prompt_tokens === 10 && parsed.usage.reasoning_tokens === 2 && parsed.usage.completion_tokens === 7);
check("Gemini function call ID normalizes", parsed.toolCalls[0].id === "call-id-1");
check("raw Gemini model content is retained", parsed.geminiContent.parts[1].thoughtSignature === "keep-this-signature");
check("Gemini max token finish reason maps to length", client.parseResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }).finishReason === "length");
const truncatedCall = client.parseResponse({
  candidates: [{
    content: { role: "model", parts: [{ functionCall: { name: "inspect_page", args: { tab: 1 } } }] },
    finishReason: "MAX_TOKENS",
  }],
});
check("MAX_TOKENS preserves truncation and suppresses tool calls", truncatedCall.finishReason === "length" && truncatedCall.toolCalls.length === 0 && truncatedCall.truncatedToolCall === true);
const malformed = client.parseResponse({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "Malformed function call: fs_write(" }] });
check("MALFORMED_FUNCTION_CALL is not a normal stop and keeps the reason", malformed.finishReason === "malformed_function_call" && malformed.finishMessage.startsWith("Malformed") && malformed.toolCalls.length === 0);

const requestHistory = toGeminiRequest([
  { role: "system", content: "First instruction." },
  { role: "developer", content: "Second instruction." },
  {
    role: "assistant",
    content: "Inspecting.",
    tool_calls: parsed.toolCalls,
    gemini_content: responseContent,
  },
  { role: "tool", tool_call_id: parsed.toolCalls[0].id, content: '{"ok":true,"data":{"title":"Example"}}' },
]);
check("stateless tool loop replays raw thoughtSignature", requestHistory.contents[0].parts[1].thoughtSignature === "keep-this-signature");
check("tool result is correlated by function name", requestHistory.contents[1].parts[0].functionResponse.name === "inspect_page");
check("tool result returns the original Gemini call ID", requestHistory.contents[1].parts[0].functionResponse.id === "call-id-1");
check("system and developer instructions are combined", requestHistory.systemInstruction.parts[0].text === "First instruction.\n\nSecond instruction.");
const localIdHistory = toGeminiRequest([
  { role: "assistant", tool_calls: [{ id: "local-call-id", function: { name: "inspect_page", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "local-call-id", content: "{}" },
]);
check("local tool correlation IDs are not sent to Gemini", localIdHistory.contents[1].parts[0].functionResponse.id === undefined);

console.log("[3] Parse Gemini stream");
const streamEvents = [
  { candidates: [{ content: { role: "model", parts: [{ text: "Checking DOM.", thought: true }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "Inspect " }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "this page." }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "", thoughtSignature: "text-signature" }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "fs_write", args: { path: "a.js", content: "X", append: true } }, thoughtSignature: "stream-signature" }] } }] },
  {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "fs_write", args: { path: "b.js", content: "Y" } } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, thoughtsTokenCount: 4 },
  },
];
const streamText = streamEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const encoder = new TextEncoder();
let streamedText = "";
let streamedReasoning = "";
const streamed = await client._readStreamGemini(
  new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(streamText)); controller.close(); } })),
  delta => { streamedText += delta; },
  delta => { streamedReasoning += delta; }
);
check("text and thought deltas reach callbacks", streamedText === "Inspect this page." && streamedReasoning === "Checking DOM.");
check(
  "parallel calls of the same function stay separate, in arrival order, with their own arguments",
  streamed.toolCalls.length === 2 && streamed.toolCalls[0].function.arguments === '{"path":"a.js","content":"X","append":true}' && streamed.toolCalls[1].function.arguments === '{"path":"b.js","content":"Y"}'
);
check("stream usage counts thoughts as output", streamed.usage.prompt_tokens === 7 && streamed.usage.completion_tokens === 12 && streamed.usage.reasoning_tokens === 4);
const streamParts = streamed.geminiContent.parts;
check("text chunks merge and a late signature attaches to its text", streamParts.length === 4 && streamParts[0].thought === true && streamParts[1].text === "Inspect this page." && streamParts[1].thoughtSignature === "text-signature");
check("signed function call parts are returned as received", streamParts[2].thoughtSignature === "stream-signature" && streamParts[2].functionCall.args.path === "a.js" && streamParts[3].functionCall.args.path === "b.js");
const malformedStream = await client._readStreamGemini(
  new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL","finishMessage":"bad call"}]}\n')); controller.close(); } })),
  () => {},
  () => {}
);
check("a malformed call reported on the stream keeps its reason", malformedStream.finishReason === "malformed_function_call" && malformedStream.finishMessage === "bad call");

console.log("[4] AgentLoop preserves Gemini model parts through tool execution");
let turn = 0;
let rawModelContentReturned = false;
const router = {
  listSpecs: () => [tool],
  needsConfirm: () => false,
  dispatch: async () => ({ ok: true, data: { title: "Example" } }),
};
const mockClient = {
  model: "gemini-2.5-flash",
  chat: async messages => {
    turn++;
    if (turn === 1) {
      return {
        content: "",
        toolCalls: [{ id: "gemini-call-1", type: "function", function: { name: "inspect_page", arguments: '{"tab":1}' } }],
        geminiContent: { role: "model", parts: [{ functionCall: { name: "inspect_page", args: { tab: 1 } }, thoughtSignature: "agent-signature" }] },
      };
    }
    rawModelContentReturned = messages.some(
      message => message.role === "assistant" && message.gemini_content?.parts?.[0]?.thoughtSignature === "agent-signature"
    );
    return { content: "## Conclusion\nPage inspected.", toolCalls: [], finishReason: "stop" };
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
check("AgentLoop preserves Gemini raw content until the next tool round", rawModelContentReturned && turn === 2);
check("AgentLoop completes the Gemini tool round", turnResult.stopReason === "final" && turnResult.content.includes("Page inspected"));

let truncatedDispatches = 0;
await runAgentTurn({
  client: { model: "gemini-2.5-flash", chat: async () => truncatedCall },
  router: {
    listSpecs: () => [tool],
    needsConfirm: () => false,
    dispatch: async () => { truncatedDispatches++; return { ok: true }; },
  },
  messages: [{ role: "user", content: "Inspect this page." }],
  systemPrompt: "Browser agent.",
  maxRounds: 1,
  assist: true,
  autoApprove: true,
});
check("AgentLoop never dispatches a tool from a truncated Gemini call", truncatedDispatches === 0);

console.log("[4b] AgentLoop tells the model why a call did not happen");
const retryPrompts = [];
let malformedTurn = 0;
const malformedResult = await runAgentTurn({
  client: {
    model: "gemini-2.5-flash",
    chat: async messages => {
      malformedTurn++;
      if (malformedTurn === 1) return { content: "", toolCalls: [], finishReason: "malformed_function_call", finishMessage: "Malformed function call: fs_write(" };
      if (malformedTurn === 2) {
        retryPrompts.push(messages[messages.length - 1].content);
        return { content: "", toolCalls: [], finishReason: "length", truncatedToolCall: true };
      }
      retryPrompts.push(messages[messages.length - 1].content);
      return { content: "## Conclusion\nDone.", toolCalls: [], finishReason: "stop" };
    },
  },
  router,
  messages: [{ role: "user", content: "Write the files." }],
  systemPrompt: "Browser agent.",
  maxRounds: 4,
  assist: true,
  autoApprove: true,
});
check("a malformed call makes the model resend it with the server's reason", /无效的函数调用/.test(retryPrompts[0]) && /Malformed function call/.test(retryPrompts[0]));
check("a call cut by the output limit asks for a smaller write, not for less thinking", /分多段/.test(retryPrompts[1]) && /append/.test(retryPrompts[1]) && !/严禁长篇推理/.test(retryPrompts[1]));
check("the turn then finishes normally", malformedResult.stopReason === "final" && malformedTurn === 3);

console.log("[4c] Tool images are appended after the whole batch of results");
const screenshotTool = { type: "function", function: { name: "page_screenshot", parameters: { type: "object", properties: {} } } };
let visionTurn = 0;
let visionMessages = null;
await runAgentTurn({
  client: {
    model: "gemini-2.5-flash",
    chat: async messages => {
      visionTurn++;
      if (visionTurn === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "shot", type: "function", function: { name: "page_screenshot", arguments: "{}" } },
            { id: "info", type: "function", function: { name: "inspect_page", arguments: '{"tab":1}' } },
          ],
          geminiContent: { role: "model", parts: [{ functionCall: { name: "page_screenshot", args: {} }, thoughtSignature: "batch-signature" }, { functionCall: { name: "inspect_page", args: { tab: 1 } } }] },
        };
      }
      visionMessages = messages;
      return { content: "## Conclusion\nSeen.", toolCalls: [], finishReason: "stop" };
    },
  },
  router: {
    listSpecs: () => [screenshotTool, tool],
    needsConfirm: () => false,
    dispatch: async name => (name === "page_screenshot" ? { ok: true, data: { width: 1 }, media: [{ type: "image", dataUrl: "data:image/png;base64,QUJD" }] } : { ok: true, data: { title: "Example" } }),
  },
  messages: [{ role: "user", content: "Look at the page." }],
  systemPrompt: "Browser agent.",
  maxRounds: 2,
  assist: true,
  autoApprove: true,
  vision: true,
});
const roles = visionMessages.map(m => m.role).join(",");
check("tool results stay together and the image message comes after them", /assistant,tool,tool,user$/.test(roles) && Array.isArray(visionMessages[visionMessages.length - 1].content));
const visionContents = toGeminiRequest(visionMessages).contents;
check(
  "Gemini gets one function response per call before the image",
  visionContents[1].parts.filter(p => p.functionCall).length === 2 && visionContents[2].parts.length === 2 && visionContents[2].parts.every(p => p.functionResponse) && visionContents[3].parts.some(p => p.inlineData)
);

console.log("[5] Thought summaries fall back when the model rejects thinkingConfig");
const originalFetch = globalThis.fetch;
const bodies = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  bodies.push(body);
  if (body.generationConfig?.thinkingConfig) {
    return new Response('{"error":{"code":400,"message":"Thinking is not supported for this model"}}', { status: 400, statusText: "Bad Request" });
  }
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  const flash = new LlmClient({ protocol: PROTOCOLS.GEMINI, baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", model: "gemini-2.0-flash" });
  const result = await flash.chat([{ role: "user", content: "hi" }]);
  check("a rejected thinkingConfig is retried without it", result.content === "ok" && bodies.length === 2 && !!bodies[0].generationConfig.thinkingConfig && bodies[1].generationConfig.thinkingConfig === undefined);
  check("the rejection is remembered for this model", JSON.parse(flash.buildRequest([{ role: "user", content: "hi" }]).init.body).generationConfig.thinkingConfig === undefined);
  check("other models on the endpoint still ask for thoughts", JSON.parse(client.buildRequest([{ role: "user", content: "hi" }]).init.body).generationConfig.thinkingConfig.includeThoughts === true);
  globalThis.fetch = async () => new Response('{"error":{"code":400,"message":"Invalid argument"}}', { status: 400, statusText: "Bad Request" });
  const pro = new LlmClient({ protocol: PROTOCOLS.GEMINI, baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", model: "gemini-2.5-pro" });
  let failed = null;
  try {
    await pro.chat([{ role: "user", content: "hi" }]);
  } catch (e) {
    failed = e;
  }
  check("a 400 that survives the retry does not blacklist thought summaries", failed?.status === 400 && JSON.parse(pro.buildRequest([{ role: "user", content: "hi" }]).init.body).generationConfig.thinkingConfig.includeThoughts === true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\nGemini 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
