/* Gemini GenerateContent protocol regression tests; no live API calls. */
import { LlmClient, PROTOCOLS, toGeminiRequest } from "../modules/LlmClient.sys.mjs";
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
      type: "object",
      properties: { tab: { type: "integer", description: "Tab id" } },
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
check("function declarations use Gemini schema types", body.tools[0].functionDeclarations[0].parameters.type === "OBJECT" && body.tools[0].functionDeclarations[0].parameters.properties.tab.type === "INTEGER");
check("unsupported JSON Schema fields are removed", body.tools[0].functionDeclarations[0].parameters.additionalProperties === undefined);

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
check("Google usage fields normalize", parsed.usage.prompt_tokens === 10 && parsed.usage.reasoning_tokens === 2);
check("Gemini function call ID normalizes", parsed.toolCalls[0].id === "call-id-1");
check("raw Gemini model content is retained", parsed.geminiContent.parts[1].thoughtSignature === "keep-this-signature");
check("Gemini max token finish reason maps to length", client.parseResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }).finishReason === "length");
const truncatedCall = client.parseResponse({
  candidates: [{
    content: { role: "model", parts: [{ functionCall: { name: "inspect_page", args: { tab: 1 } } }] },
    finishReason: "MAX_TOKENS",
  }],
});
check("MAX_TOKENS preserves truncation and suppresses tool calls", truncatedCall.finishReason === "length" && truncatedCall.toolCalls.length === 0);

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
  { candidates: [{ content: { role: "model", parts: [{ text: "Inspect " }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "this page." }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "Checking DOM.", thought: true }] } }] },
  {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "inspect_page", args: { tab: 1 } }, thoughtSignature: "stream-signature" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
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
check("stream function call and usage parse", streamed.toolCalls[0].function.arguments === '{"tab":1}' && streamed.usage.prompt_tokens === 7);
check("stream keeps the call signature for the next request", streamed.geminiContent.parts.some(part => part.thoughtSignature === "stream-signature"));

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

console.log(`\nGemini 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
