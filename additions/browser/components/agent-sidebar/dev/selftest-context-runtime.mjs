import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

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

const requests = [];
let call = 0;
const client = {
  model: "small-test",
  async chat(messages, opts) {
    requests.push({ messages, opts });
    call++;
    if (call === 1) {
      return {
        content: "",
        reasoningContent: "",
        finishReason: "tool_calls",
        usage: { prompt_tokens: 100, completion_tokens: 10 },
        toolCalls: [{ id: "c1", type: "function", function: { name: "alpha", arguments: "{}" } }],
      };
    }
    return {
      content: "## 结论\n完成",
      reasoningContent: "",
      finishReason: "stop",
      usage: { prompt_tokens: 120, completion_tokens: 12 },
      toolCalls: [],
    };
  },
};
const router = {
  maxChars: 20000,
  listSpecs() {
    return [
      { type: "function", function: { name: "zeta", parameters: { type: "object" } } },
      { type: "function", function: { name: "alpha", parameters: { type: "object" } } },
    ];
  },
  needsConfirm() { return false; },
  async dispatch() { return { ok: true, data: "A".repeat(30000) + "TAIL" }; },
};
const usages = [];
const artifacts = [];
const result = await runAgentTurn({
  client,
  router,
  messages: [{ role: "user", content: "original task" }],
  systemPrompt: "stable system",
  dynamicContext: "workspace=/tmp/example",
  getLedger: async () => "ledger=fact",
  contextStrategy: "projected",
  cacheKey: "thread:model:v1",
  autoApprove: true,
  maxRounds: 3,
  onUsage: (raw, info) => usages.push({ raw, info }),
  persistToolArtifact: async artifact => {
    artifacts.push(artifact);
    return { path: ".frx-context/tool-results/a.json" };
  },
});

ok(result.content.includes("完成"), "Agent result remains unchanged");
ok(requests[0].messages[0].content === "stable system", "system prompt stays byte-stable");
ok(!requests[0].messages[0].content.includes("workspace"), "dynamic context is not placed in system");
ok(requests[0].messages.find(m => m.role === "user")?.content.includes("workspace=/tmp/example"), "dynamic context is attached to current user task");
ok(requests[0].opts.tools.map(t => t.function.name).join(",") === "alpha,zeta", "tool specs use deterministic ordering");
ok(requests.every(r => r.opts.cacheKey === "thread:model:v1"), "all main requests share one cache key");
ok(artifacts.length === 1 && artifacts[0].content.endsWith("TAIL\"}"), "large tool result is persisted before folding");
const folded = requests[1].messages.find(m => m.role === "tool")?.content || "";
ok(folded.includes(".frx-context/tool-results/a.json") && folded.includes("TAIL"), "model context keeps artifact path and result tail");
ok(folded.length < 13000, "folded tool output is bounded");
const toolIndex = requests[1].messages.findIndex(m => m.role === "tool");
ok(toolIndex > 0 && requests[1].messages[toolIndex - 1].role === "assistant", "tool result keeps its assistant tool-call parent");
ok(usages.length === 2 && usages.every(u => u.info.phase === "chat"), "usage callback covers every main request");

let legacyCall = 0;
const legacyRequests = [];
const legacyClient = {
  model: "small-test",
  async chat(messages, opts) {
    legacyRequests.push({ messages, opts });
    legacyCall++;
    return legacyCall === 1
      ? {
          content: "",
          toolCalls: [{ id: "legacy", type: "function", function: { name: "alpha", arguments: "{}" } }],
          usage: null,
        }
      : { content: "## 结论\nlegacy ok", toolCalls: [], usage: null };
  },
};
let legacyArtifacts = 0;
await runAgentTurn({
  client: legacyClient,
  router,
  messages: [{ role: "user", content: "legacy task" }],
  systemPrompt: "stable system",
  contextStrategy: "legacy",
  autoApprove: true,
  maxRounds: 3,
  persistToolArtifact: async () => { legacyArtifacts++; return { path: "unused" }; },
});
const legacyTool = legacyRequests[1].messages.find(m => m.role === "tool")?.content || "";
ok(legacyArtifacts === 0 && legacyTool.length > 30000, "legacy strategy preserves previous tool-result behavior");

console.log(`\nContext runtime selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
