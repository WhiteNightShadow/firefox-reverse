/* dev/selftest-toolrouter.mjs — 脊梁自测（Node，无需编译/网络）。
 * 验证：ToolRouter 注册/列规格/派发/信封/截断 + Tools backend 门控 + AgentLoop tool_use 闭环。
 *
 *   node dev/selftest-toolrouter.mjs
 */
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { createBuiltinTools } from "../modules/Tools.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

let pass = 0,
  fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fail++;
    console.error("  ✗ FAIL:", msg);
  }
};

// ── mock backends（N0 只接 page + code）──
const pageBackend = {
  eval: async a => ({ type: "number", value: 42, expr: a.expression }),
};
const codeBackend = {
  search: async a => ({
    hits: [{ file: "app.bundle.js", line: 1234, text: `var ${a.query}=function(){...}` }],
    total: 1,
    query: a.query,
  }),
};

console.log("[1] ToolRouter 注册 + backend 门控");
const router = new ToolRouter();
router.registerAll(createBuiltinTools({ page: pageBackend, code: codeBackend }));
const names = router.names().sort();
ok(
  JSON.stringify(names) === JSON.stringify(["code_search", "page_eval"]),
  `仅注册有 backend 的工具: ${JSON.stringify(names)}（page_navigate 因无 backend 被门控掉）`
);
const specs = router.listSpecs();
ok(
  specs.length === 2 &&
    specs.every(s => s.type === "function" && s.function && s.function.name && s.function.parameters),
  "listSpecs() 形状符合 OpenAI tools"
);

console.log("[2] dispatch 信封语义");
ok((await router.dispatch("code_search", { query: "_0x25788b" })).data.total === 1, "正常派发 → ok + data");
ok((await router.dispatch("nope", {})).error.includes("unknown"), "未知工具 → ok:false unknown");
ok((await router.dispatch("page_eval", {})).error.includes("expression"), "缺必填 → ok:false 指出字段");

const r2 = new ToolRouter({ maxChars: 50 });
r2.register({ name: "boom", handler: async () => { throw new Error("kaboom"); } });
r2.register({ name: "big", handler: async () => "x".repeat(500) });
ok((await r2.dispatch("boom", {})).error === "kaboom", "handler 抛错 → 兜成 ok:false error");
const bigEnv = await r2.dispatch("big", {});
ok(bigEnv.ok && bigEnv.data._truncated && bigEnv.meta.truncated, "超大结果 → 截断标记");

console.log("[3] AgentLoop tool_use 闭环（mock LLM）");
let sawTools = false;
const mockClient = {
  async chat(messages, opts) {
    if (opts && Array.isArray(opts.tools) && opts.tools.some(t => t.function.name === "code_search")) {
      sawTools = true;
    }
    const hasToolResult = messages.some(m => m.role === "tool");
    if (!hasToolResult) {
      // 第一轮：要求调用 code_search
      return {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "code_search", arguments: JSON.stringify({ query: "_0x25788b" }) },
          },
        ],
        finishReason: "tool_calls",
        usage: null,
        raw: {},
      };
    }
    // 第二轮：拿到工具结果后给最终答复
    return { content: "在 app.bundle.js:1234 找到 _0x25788b", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
  },
};

const events = [];
const result = await runAgentTurn({
  client: mockClient,
  router,
  messages: [{ role: "user", content: "帮我在 JS 里找 RC4 key 函数" }],
  systemPrompt: "你是 firefox-reverse 内置逆向助手。",
  maxRounds: 4,
  onEvent: ev => events.push(ev.type),
});

ok(sawTools, "LLM 收到了 tools 规格");
ok(result.content === "在 app.bundle.js:1234 找到 _0x25788b", "最终答复来自第二轮（工具结果回灌后）");
ok(result.rounds === 2 && result.stopReason === "stop", `两轮收敛 stop（rounds=${result.rounds}）`);
ok(result.toolCalls.length === 1 && result.toolCalls[0].name === "code_search", "记录了 1 次 code_search 调用");
ok(result.toolCalls[0].env.ok && result.toolCalls[0].env.data.total === 1, "工具调用结果信封正确");
const tcMsg = result.messages.find(m => m.role === "assistant" && m.tool_calls);
const toolMsg = result.messages.find(m => m.role === "tool");
ok(!!tcMsg && !!toolMsg && toolMsg.tool_call_id === "call_1", "消息序列含 assistant(tool_calls)+tool(结果) 回灌");
ok(events.includes("tool_call") && events.includes("tool_result") && events.includes("final"), "onEvent 推送了 tool_call/tool_result/final");

console.log("[4] 改动型工具的用户确认门控（A3）");
ok(router.needsConfirm("page_eval") === true, "page_eval 标记为需确认");
ok(router.needsConfirm("code_search") === false, "code_search 只读 → 免确认");

const pageEvalClient = {
  async chat(messages) {
    const hasTool = messages.some(m => m.role === "tool");
    if (!hasTool) {
      return {
        content: "",
        toolCalls: [
          { id: "pe1", type: "function", function: { name: "page_eval", arguments: JSON.stringify({ expression: "1+41" }) } },
        ],
        finishReason: "tool_calls",
        usage: null,
        raw: {},
      };
    }
    return { content: "done", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
  },
};
const turn = extra =>
  runAgentTurn({ client: pageEvalClient, router, messages: [{ role: "user", content: "算一下" }], ...extra });

const evD = [];
const deny = await turn({ confirm: async () => false, onEvent: e => evD.push(e.type) });
ok(deny.toolCalls[0].env.denied === true, "confirm=false → 工具被拒(denied)，不执行");
ok(evD.includes("confirm_request") && evD.includes("confirm_result"), "拒绝路径推送 confirm_request/result 事件");
ok((await turn({ confirm: async () => true })).toolCalls[0].env.data.value === 42, "confirm=true → 正常执行(page_eval=42)");
ok((await turn({ autoApprove: true })).toolCalls[0].env.ok, "autoApprove → 跳过确认直接执行");
ok((await turn({})).toolCalls[0].env.denied === true, "需确认但无回调且非 autoApprove → 默认安全拒绝");

console.log("[5] 全 backend → 全工具注册（6 能力 + 页面自动操作）");
const fullBackends = {
  page: {
    eval: async () => ({ ok: true }), info: async () => ({ ok: true }), navigate: async () => ({ ok: true }),
    elements: async () => ({ ok: true }), click: async () => ({ ok: true }), type: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }), screenshot: async () => ({ ok: true }),
  },
  net: { capture: async () => ({ ok: true }), list: async () => ({ ok: true }), get: async () => ({ ok: true }) },
  scripts: { list: async () => ({ ok: true }), save: async () => ({ ok: true }), captureAll: async () => ({ ok: true }) },
  code: { search: async () => ({ ok: true }) },
  jsvmp: {
    trace: async () => ({ ok: true }), query: async () => ({ ok: true }), status: async () => ({ ok: true }),
    splitDispatcher: async () => ({ ok: true }), disassemble: async () => ({ ok: true }),
  },
  workspace: {
    list: async () => ({ ok: true }), read: async () => ({ ok: true }), write: async () => ({ ok: true }),
    mkdir: async () => ({ ok: true }), runNode: async () => ({ ok: true }), runPython: async () => ({ ok: true }),
  },
  find: { paramEntry: async () => ({ ok: true }) },
};
const fr = new ToolRouter();
fr.registerAll(createBuiltinTools(fullBackends));
const expect = ["page_eval", "page_navigate", "page_info", "page_elements", "page_click", "page_type",
  "page_scroll", "page_screenshot", "net_capture", "net_list", "net_get",
  "scripts_list", "scripts_save", "scripts_capture_all", "code_search", "find_param_entry",
  "jsvmp_trace", "jsvmp_query", "jsvmp_status", "jsvmp_split_dispatcher", "jsvmp_disassemble",
  "fs_list", "fs_read", "fs_write", "fs_mkdir", "run_node", "run_python"];
const allNames = fr.names();
const missing = expect.filter(n => !allNames.includes(n));
ok(missing.length === 0, `全部 ${expect.length} 个工具注册（缺：${missing.join(",") || "无"}）`);
ok(
  fr.needsConfirm("page_eval") && fr.needsConfirm("page_click") && fr.needsConfirm("page_type") &&
    fr.needsConfirm("scripts_capture_all") &&
    !fr.needsConfirm("find_param_entry") && !fr.needsConfirm("net_list") &&
    !fr.needsConfirm("page_screenshot") && !fr.needsConfirm("page_elements"),
  "确认标记正确（改动型需确认 / 只读免确认）"
);
// 工作目录工具：用户选了「自动执行不打断」→ run_node/run_python/fs_write 不需确认
ok(
  !fr.needsConfirm("run_node") && !fr.needsConfirm("run_python") && !fr.needsConfirm("fs_write") &&
    !fr.needsConfirm("fs_read") && !fr.needsConfirm("fs_list"),
  "工作目录工具均免确认（自动执行模式）"
);
ok((await fr.dispatch("fs_write", { path: "a.txt", content: "x" })).ok, "fs_write 可派发");
ok((await fr.dispatch("run_node", { code: "1" })).ok, "run_node 可派发");
// 无 workspace backend → fs_/run_ 工具不注册（沿用「不假装」原则）
const noWs = new ToolRouter();
noWs.registerAll(createBuiltinTools({ page: fullBackends.page }));
ok(!noWs.names().includes("fs_write") && !noWs.names().includes("run_node"), "无 workspace backend → fs_/run_ 不注册");
ok((await fr.dispatch("find_param_entry", { param: "sign" })).ok, "find_param_entry 可派发");
ok(/param/.test((await fr.dispatch("find_param_entry", {})).error), "find_param_entry 缺 param → 报错");

console.log("[6] 截图 _media 旁路截断 + 视觉回喂");
const bigImg = "data:image/png;base64," + "A".repeat(60000); // 远超 maxChars
const mr = new ToolRouter({ maxChars: 20000 });
mr.register({
  name: "page_screenshot",
  needsConfirm: false,
  handler: async () => ({ ok: true, width: 800, height: 600, note: "shot", _media: [{ type: "image", dataUrl: bigImg }] }),
});
const shotEnv = await mr.dispatch("page_screenshot", {});
ok(Array.isArray(shotEnv.media) && shotEnv.media[0].dataUrl === bigImg, "_media 抽到信封顶层、未被截断");
ok(!shotEnv.data._truncated && !JSON.stringify(shotEnv.data).includes("AAAA"), "data 不含图像（不进模型文本上下文）");

// 视觉开：截图 → 追加 user 图片消息；视觉关：不追加
const shotClient = vis => ({
  async chat(messages) {
    const hasTool = messages.some(m => m.role === "tool");
    if (!hasTool) {
      return { content: "", toolCalls: [{ id: "s1", type: "function", function: { name: "page_screenshot", arguments: "{}" } }], finishReason: "tool_calls", usage: null, raw: {} };
    }
    return { content: "看到了", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
  },
});
const visOn = await runAgentTurn({ client: shotClient(true), router: mr, messages: [{ role: "user", content: "看页面" }], autoApprove: true, vision: true, maxRounds: 3 });
const imgMsg = visOn.messages.find(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "image_url"));
ok(!!imgMsg && imgMsg.content.some(b => b.image_url && b.image_url.url === bigImg), "vision=true → 截图作为 user 图片消息回喂");
const toolMsgShot = visOn.messages.find(m => m.role === "tool");
ok(toolMsgShot && !toolMsgShot.content.includes("AAAA"), "工具文本结果不含图像 base64（省 token）");
const visOff = await runAgentTurn({ client: shotClient(false), router: mr, messages: [{ role: "user", content: "看页面" }], autoApprove: true, vision: false, maxRounds: 3 });
ok(!visOff.messages.some(m => m.role === "user" && Array.isArray(m.content)), "vision=false → 不追加图片消息");

console.log("[7] 历史消息 sanitize（UI 元数据不进上下文）");
let capturedMsgs = null;
const spyClient = {
  async chat(messages) { capturedMsgs = messages; return { content: "ok", toolCalls: [], finishReason: "stop", usage: null, raw: {} }; },
};
await runAgentTurn({
  client: spyClient, router: fr,
  messages: [{ role: "assistant", content: "hi", steps: [{ kind: "tool", name: "x" }], foo: 1 }],
  systemPrompt: "sys",
});
const sent = capturedMsgs.find(m => m.role === "assistant");
ok(sent && sent.content === "hi" && sent.steps === undefined && sent.foo === undefined, "steps/未知字段被剥离，只留 role/content");

console.log("[8] 思考型模型 reasoning_content 回灌（v4-pro 多轮工具不再 400）");
let rnd = 0;
const reasoningClient = {
  async chat() {
    rnd++;
    if (rnd === 1) {
      return { content: "", reasoningContent: "先看看页面", toolCalls: [{ id: "r1", type: "function", function: { name: "page_info", arguments: "{}" } }], finishReason: "tool_calls", usage: null, raw: {} };
    }
    return { content: "完成", reasoningContent: "", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
  },
};
let reasonStreamed = "";
const rr = await runAgentTurn({
  client: reasoningClient, router: fr, messages: [{ role: "user", content: "看页面" }],
  autoApprove: true, maxRounds: 3, onReasoning: c => { reasonStreamed += c; },
});
const asstR = rr.messages.find(m => m.role === "assistant" && m.tool_calls);
ok(asstR && asstR.reasoning_content === "先看看页面", "assistant(tool_calls) 消息回灌了 reasoning_content");
ok(rr.content === "完成", "思考模型多轮收敛到最终答复");

console.log(`\n脊梁自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
