/* dev/selftest-loop-guard.mjs — 长任务忘了结论、从头重做、绕圈（#5）。
 *   - A2 的结果指纹、无进展判定、失败判定都看工具返回的 data：分页读文件不再被误熔断，返回值里每次都变的字段
 *     （ref、scannedAt）不算结果变化，工具返回 { ok:false } 也算失败，脚本失败按输出末尾真正的报错行归类；
 *   - 重复调用提示和循环检测只认只读查询的重复：被 A2 拒绝的新调用、采样流程里固定回执的开关/重置都不算；
 *     先提醒，提醒后仍在重复就停下本轮（stopReason=loop）；提醒不会因为压缩丢掉，模型按提醒汇报就收尾；
 *   - 压缩：交接摘要能看到最新的执行记录、用户的原话、锚点之前的对话和上一份存档；交接摘要被截断或没生成出来时，
 *     之前确认过的内容原样带着（不截半句、不越带越少），过时的「下一步」不带，引用的对话不会被当成结论；
 *   - 账本的自动沉淀只收模型这一次写出来的账本，只增不减，新结论不会被早就入库的旧条目挤掉；
 *   - 自动续跑的回合里任务锚点还是用户发的那条任务，上一回合发过的消息原样再发（前缀缓存接得上）；
 *   - AgentSession 一次执行的所有回合共用一份状态，引擎停下的原因会补成一段正文。
 * 不调用真实模型，不启动浏览器。 */
import assert from "node:assert/strict";
import { createRunState, runAgentTurn } from "../modules/AgentLoop.sys.mjs";
import { LedgerBackend } from "../modules/LedgerBackend.sys.mjs";
import { LlmClient, PROTOCOLS } from "../modules/LlmClient.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { loadAgentSession } from "./agent-session-harness.mjs";

let pass = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  pass++;
  console.log("  ✓", message);
};

/** 按脚本回复的假模型：交接摘要请求、收尾请求（轮数用尽的不带工具；循环检测停下时的带工具、但要求不再调用）、
 *  带工具的主请求分开处理。未超预算时 trimContext 原样返回 msgs，之后还会被追加，所以记录时先拍快照。
 *  final 可以返回字符串，也可以返回完整的回复对象（比如带着工具调用）。 */
function scriptedClient({ main, handoff, final, model = "small-test" }) {
  const log = { main: [], handoff: [], final: [], finalOpts: [] };
  let round = 0;
  return {
    log,
    model,
    async chat(messages, opts = {}) {
      const system = messages[0] && messages[0].role === "system" ? String(messages[0].content) : "";
      if (system.includes("Findings Ledger")) {
        const source = String(messages[1].content);
        log.handoff.push(source);
        return handoff ? handoff(log.handoff.length, source) : { content: "", finishReason: "stop" };
      }
      const last = messages.at(-1);
      const report = !!last && last.role === "user" && String(last.content).includes("本轮到此停下");
      if (!opts.tools || report) {
        log.final.push(messages.slice());
        log.finalOpts.push(opts);
        const reply = final ? final(messages) : "## 结论\n收尾";
        return typeof reply === "string" ? { content: reply, finishReason: "stop", toolCalls: [] } : reply;
      }
      round++;
      log.main.push(messages.slice());
      return main(round, messages);
    },
  };
}
const toolCall = (id, name, args, content = "") => ({
  content,
  finishReason: "tool_calls",
  toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const done = text => ({ content: text, finishReason: "stop", toolCalls: [] });

/** 真实 ToolRouter（信封是 { ok, data }），几个确定性的假工具。world 是假工具共用的「页面状态」。 */
function makeRouter(world = {}) {
  const router = new ToolRouter();
  let refs = 0;
  router.registerAll([
    // 只读查询
    { name: "read_doc", handler: async ({ path, offset = 0 }) => ({ content: `${path}@${offset}` }) },
    { name: "grep_code", handler: async ({ q }) => ({ hits: [{ line: 1, text: String(q) }] }) },
    { name: "big_read", handler: async ({ n }) => ({ text: `MARK-${n} ` + "x".repeat(40000) }) },
    // 像 code_search：没命中时返回值里不带查询词，查什么都是同一份结果
    { name: "search_const", handler: async () => ({ ok: true, count: 0, hits: [], note: "no match" }) },
    // 像 page_snapshot：每次扫描都给元素重新发 ref，另带扫描时间；页面内容由 world.page 决定
    {
      name: "snap",
      handler: async () => ({
        ok: true,
        count: 2,
        scannedAt: `t${++refs}`,
        elements: [
          { ref: `e:${++refs}`, role: "button", name: world.page || "登录" },
          { ref: `e:${++refs}`, role: "link", name: "帮助" },
        ],
      }),
    },
    // 像 net_get：要找的请求不存在时不抛错，返回 ok:false
    { name: "lookup", handler: async ({ id }) => ({ ok: false, error: `request not found: ${id}` }) },
    // 豁免重复的操作
    { name: "scroll", repeatExempt: true, handler: async () => ({ moved: true }) },
    // 像 page_eval：world.value 变了结果才变
    { name: "eval_page", needsConfirm: true, repeatExempt: true, handler: async ({ expr }) => ({ value: `${expr}=${world.value || 0}` }) },
    // 像 run_node：脚本失败时不抛错，返回 { ok:false, exitCode, output }。out 可以直接给出进程输出。
    {
      name: "run_script",
      needsConfirm: true,
      repeatExempt: true,
      handler: async ({ n, pass: ok, out }) =>
        ok
          ? { ok: true, exitCode: 0, output: "done" }
          : { ok: false, exitCode: 1, output: out || `TypeError: fn_${n} is not a function\n    at run (/w/a${n}.js:${n}:5)` },
    },
    { name: "big_fail", needsConfirm: true, repeatExempt: true, handler: async ({ n }) => ({ ok: false, exitCode: 1, output: `case ${n}\n` + "y".repeat(270000) }) },
    { name: "write_file", needsConfirm: true, repeatExempt: true, progress: true, handler: async ({ path }) => ({ ok: true, path }) },
    { name: "save_thing", progress: true, handler: async ({ n }) => ({ ok: false, error: `disk full ${n}` }) },
    // 像 signer_trace / hook_inject：改动型，start/stop 的回执每次都一样，query 每次是新数据
    {
      name: "tracer",
      needsConfirm: true,
      handler: async ({ action }) =>
        action === "query"
          ? { ok: true, records: [{ sample: (world.samples = (world.samples || 0) + 1) }] }
          : { ok: true, action, state: action === "start" ? "tracing" : "idle" },
    },
    // 像 clear_site_data：改动型 + 落盘类，回执固定；重置之后页面里的值会变
    {
      name: "reset_site",
      needsConfirm: true,
      progress: true,
      handler: async () => {
        world.value = (world.value || 0) + 1;
        return { ok: true, cleared: true };
      },
    },
  ]);
  return router;
}
const toolTexts = result => result.messages.filter(m => m.role === "tool").map(m => String(m.content));
const userTexts = messages => messages.filter(m => m.role === "user").map(m => String(m.content));
const run = (client, extra = {}) =>
  runAgentTurn({
    client,
    router: makeRouter(),
    messages: [{ role: "user", content: "任务" }],
    systemPrompt: "sys",
    autoApprove: true,
    contextStrategy: "legacy",
    maxRounds: 40,
    ...extra,
  });
/** 把一段文本交给账本的自动沉淀，看它认出哪些条目（不碰 SQLite）。 */
async function ledgerItems(text) {
  const ledger = new LedgerBackend();
  let items = [];
  ledger._addMany = async list => {
    items = list;
    return { added: list.length, dedup: 0, unchanged: 0 };
  };
  await ledger.mergeHandoff(text, {});
  return items;
}
const NOTE_START = "（上面是你已完成的【进展存档】";
const WARNING_START = "（系统·循环检测）你最近的工具调用里有";
const longStep = (n, extra = "") => `STEP-${n} ` + "分析".repeat(6000) + extra;
const eventsOf = (events, type) => events.filter(e => e.type === type).length;
const CYCLE = [
  ["grep_code", { q: "a" }],
  ["grep_code", { q: "b" }],
  ["read_doc", { path: "x.js", offset: 0 }],
];
const cycleCall = r => toolCall("c" + r, ...CYCLE[(r - 1) % CYCLE.length]);

console.log("A2 结果指纹");
{
  // 分页读一个大文件：参数只差 offset（_callSig 把数字归一成同一个签名），内容每次都不同。
  const paging = await run(
    scriptedClient({
      main: r => (r <= 14 ? toolCall("p" + r, "read_doc", { path: "bundle.js", offset: r * 20000 }) : done("## 结论\n读完了")),
    })
  );
  const texts = toolTexts(paging);
  check(texts.length === 14 && texts.every(t => !t.includes("⛔")), "分页读文件 14 次都照常执行，不再被当成同参同结果熔断");
  check(texts.every(t => !t.includes("重复调用")), "参数不同的调用不算重复");
  check(paging.stopReason === "final", "分页读完正常收尾");

  const same = await run(
    scriptedClient({
      main: r => (r <= 11 ? toolCall("s" + r, "read_doc", { path: "same.js", offset: 0 }) : done("## 结论\n停")),
    })
  );
  const sameTexts = toolTexts(same);
  check(sameTexts[10].includes("⛔") && sameTexts.slice(0, 10).every(t => !t.includes("⛔")), "完全相同的结果照样在第 11 次被 A2 拒绝执行");
  check(sameTexts[10].includes("已用**相同参数**调用 read_doc 11 次"), "拒绝的说法：这个调用确实做过，说「相同参数」");
  check(sameTexts[1].includes("重复调用") && sameTexts[1].includes("1 次"), "第二次相同调用就带上重复提示");

  const reordered = await run(
    scriptedClient({
      main: r =>
        r <= 11 ? toolCall("k" + r, "read_doc", r % 2 ? { path: "k.js", offset: 0 } : { offset: 0, path: "k.js" }) : done("## 结论\n停"),
    })
  );
  check(toolTexts(reordered)[10].includes("⛔"), "参数的键换个先后还是同一个调用，照样在第 11 次被拒绝");

  // 页面没变：page_snapshot 这类工具每次重新发 ref、带扫描时间，结果按「没变」算。
  const events = [];
  const polling = await run(scriptedClient({ main: r => (r <= 12 ? toolCall("n" + r, "snap", {}) : done("## 结论\n页面一直没变")) }), {
    onEvent: ev => events.push(ev),
  });
  const snapTexts = toolTexts(polling);
  check(snapTexts[1].includes("重复调用"), "返回值里只有 ref、扫描时间不同：第二次就提示重复");
  check(snapTexts[10].includes("⛔") && eventsOf(events, "loop_warning") === 1, "页面没变时反复快照，第 11 次被拒绝，循环检测也看得到");
  const world = {};
  const changing = await runAgentTurn({
    client: scriptedClient({
      main: r => {
        if (r === 3) {
          world.page = "欢迎回来";
        }
        return r <= 4 ? toolCall("v" + r, "snap", {}) : done("## 结论\n登录成功");
      },
    }),
    router: makeRouter(world),
    messages: [{ role: "user", content: "任务" }],
    autoApprove: true,
  });
  const changed = toolTexts(changing);
  check(changed[1].includes("重复调用") && !changed[2].includes("重复调用") && changed[3].includes("重复调用"), "页面内容变了就是新结果，不算重复");

  // 返回值里 ok:false 的失败：和抛错一样按归一化的错误文本算指纹。
  const missing = await run(scriptedClient({ main: r => (r <= 11 ? toolCall("m" + r, "lookup", { id: r }) : done("## 结论\n没有")) }));
  const missingTexts = toolTexts(missing);
  check(
    missingTexts[10].includes("⛔") && missingTexts.slice(0, 10).every(t => !t.includes("⛔")),
    "工具返回 { ok:false } 的同类失败连续 10 次，第 11 次被拒绝"
  );
  check(
    missingTexts[10].includes("这一类调用（参数只有数字不同）") && !missingTexts[10].includes("相同参数"),
    "拒绝的说法：这个调用没做过（只是数字不同），不说「已用相同参数调用」"
  );
}

console.log("重复调用提示");
{
  const result = await run(
    scriptedClient({
      main: r =>
        [
          toolCall("c1", "read_doc", { path: "a.js", offset: 0 }),
          toolCall("c2", "read_doc", { offset: 0, path: "a.js" }),
          toolCall("c3", "scroll", {}),
          toolCall("c4", "scroll", {}),
          toolCall("c5", "tracer", { action: "start" }),
          toolCall("c6", "tracer", { action: "start" }),
          done("## 结论\nok"),
        ][r - 1],
    })
  );
  const texts = toolTexts(result);
  check(!texts[0].includes("重复调用") && texts[1].includes("重复调用"), "参数键顺序不同也认得是同一个调用");
  check(!texts[3].includes("重复调用"), "豁免重复的工具（滚动）不提示");
  check(!texts[5].includes("重复调用"), "改动型工具（开关 trace）回执相同也不提示：那是正当的重复");

  const spaced = await run(
    scriptedClient({
      main: r =>
        r === 1 || r === 8 ? toolCall("g" + r, "read_doc", { path: "a.js", offset: 0 }) : r <= 7 ? toolCall("g" + r, "scroll", {}) : done("## 结论\nok"),
    })
  );
  check(toolTexts(spaced)[7].includes("上一次在 7 次工具调用之前"), "「上一次在几次调用之前」数的是所有工具调用，中间的滚动也算");

  const many = await run(
    scriptedClient({
      main: r =>
        r <= 3 ? toolCall("h" + r, "read_doc", { path: "m.js", offset: 0 }) : r <= 6 ? toolCall("h" + r, "grep_code", { q: "q" + r }) : done("## 结论\nok"),
    }),
    { maxPerTool: 2 }
  );
  const manyTexts = toolTexts(many);
  check(manyTexts[2].includes("重复调用") && !manyTexts[2].includes("放心干"), "重复的调用不再同时附上「正常推进，放心干」");
  check(manyTexts[5].includes("放心干") && !manyTexts[5].includes("重复调用"), "每次都不一样的调用，次数多了照旧只有温和提示");
}

console.log("循环检测：提醒后仍重复就停下");
{
  const events = [];
  const client = scriptedClient({
    main: cycleCall,
    // 汇报请求里模型还是发了工具调用：不执行，只取文字。
    final: () => ({
      content: "已确认：签名在 x.js；卡在 b 的含义。",
      finishReason: "tool_calls",
      toolCalls: [{ id: "late", type: "function", function: { name: "read_doc", arguments: '{"path":"late.js","offset":0}' } }],
    }),
  });
  const result = await run(client, { maxRounds: 60, onEvent: ev => events.push(ev) });
  const warned = client.log.main.findIndex(messages => messages.some(m => m.role === "user" && String(m.content).startsWith(WARNING_START)));
  check(warned === 12, "第 12 次调用后注入循环提醒");
  const warning = userTexts(client.log.main[12]).find(t => t.startsWith(WARNING_START));
  check(warning.includes("有 9 次是之前做过的查询或读取") && warning.includes("只有 3 次"), "提醒里写明几次是重复、几次拿到了新结果");
  check(eventsOf(events, "loop_warning") === 1 && eventsOf(events, "loop_stop") === 1, "发出 loop_warning 和 loop_stop 事件");
  check(result.stopReason === "loop" && result.rounds === 24, "提醒之后又重复满一个窗口，在第 24 轮停下，stopReason=loop");
  check(result.content.includes("签名在 x.js") && result.content.includes("检测到循环"), "停下时先让模型汇报，再附上停下的原因");
  check(result.notice.startsWith("（系统）⚠ 检测到循环") && result.content.endsWith(result.notice), "停下的原因另外放在 notice 里，供界面显示");
  check(!result.notice.includes('"q"') && result.notice.includes("grep_code"), "给用户看的停止说明只列工具名，不带参数");
  check(client.log.final.length === 1 && Array.isArray(client.log.finalOpts[0].tools), "汇报请求照样带工具声明，只是明确要求不再调用工具");
  check(
    result.toolCalls.length === 24 && result.toolCalls.every(call => call.args.path !== "late.js"),
    "汇报请求里模型发的工具调用不执行"
  );

  const recovered = await run(
    scriptedClient({
      main: r => (r <= 12 ? cycleCall(r) : r <= 24 ? toolCall("r" + r, "grep_code", { q: "new-" + r }) : done("## 结论\n换路后完成")),
    })
  );
  check(recovered.stopReason === "final", "提醒之后换了路线（新调用）就不会被停下");
}

console.log("循环检测：不把正常推进当成循环");
{
  // 逐个搜不同的常量，都没命中（返回值不带查询词，结果逐字节相同）。A2 按归一化的参数从第 11 次起拒绝执行，
  // 但这些调用一次都没重复过。
  const events = [];
  const constants = await run(
    scriptedClient({
      main: r => (r <= 32 ? toolCall("k" + r, "search_const", { q: "0x" + (0x67452301 + r * 7919).toString(16) }) : done("## 结论\n常量表里没有")),
    }),
    { maxRounds: 60, onEvent: ev => events.push(ev) }
  );
  const texts = toolTexts(constants);
  check(texts.filter(t => !t.includes("⛔")).length === 10 && texts[10].includes("⛔"), "32 个不同的常量：前 10 次执行，之后被 A2 拒绝（原有行为）");
  check(
    eventsOf(events, "loop_warning") === 0 && eventsOf(events, "loop_stop") === 0 && constants.stopReason === "final",
    "被 A2 拒绝的调用没做过，不算重复：不提醒、不停下，正常收尾"
  );

  // 同一段读了 10 遍（确实在重复），提醒之后改读别的 offset——这些新调用被 A2 拒绝，但不能算「仍在重复」。
  const offsets = [];
  const moved = await run(
    scriptedClient({
      main: r =>
        r <= 24 ? toolCall("o" + r, "read_doc", { path: "same.js", offset: r <= 10 ? 0 : r * 100 }) : done("## 结论\n这个文件读不下去，换文件"),
    }),
    { maxRounds: 60, onEvent: ev => offsets.push(ev) }
  );
  check(
    eventsOf(offsets, "loop_warning") === 1 && eventsOf(offsets, "loop_stop") === 0 && moved.stopReason === "final",
    "重复读同一段会被提醒一次；之后换了 offset 就算恢复，不会被停下"
  );

  // 工具说明里写的采样流程：start → 触发 → query → stop，每组样本来一遍。
  const sampling = [];
  const world = {};
  const steps = [
    ["tracer", { action: "start" }],
    ["scroll", {}],
    ["tracer", { action: "query" }],
    ["tracer", { action: "stop" }],
  ];
  const sampled = await runAgentTurn({
    client: scriptedClient({ main: r => (r <= 36 ? toolCall("t" + r, ...steps[(r - 1) % 4]) : done("## 结论\n9 组样本采完")) }),
    router: makeRouter(world),
    messages: [{ role: "user", content: "采 9 组样本" }],
    autoApprove: true,
    maxRounds: 60,
    onEvent: ev => sampling.push(ev),
  });
  check(
    eventsOf(sampling, "loop_warning") === 0 && sampled.stopReason === "final" && world.samples === 9,
    "每组都开关一次 trace（回执相同）不算循环，9 组样本全部采完"
  );
  check(toolTexts(sampled).every(t => !t.includes("重复调用") && !t.includes("⛔")), "开关 trace 的结果里没有「别从头重做」的提示");

  // 每组先清站点数据再取新签名、跑新脚本。
  const resetting = [];
  const resetWorld = {};
  const reset = await runAgentTurn({
    client: scriptedClient({
      main: r => {
        const group = Math.ceil(r / 3);
        if (r > 27) {
          return done("## 结论\n9 组都验证过了");
        }
        return [
          toolCall("z" + r, "reset_site", { reload: true }),
          toolCall("z" + r, "eval_page", { expr: "sig()" }),
          toolCall("z" + r, "run_script", { n: group, pass: true }),
        ][(r - 1) % 3];
      },
    }),
    router: makeRouter(resetWorld),
    messages: [{ role: "user", content: "验证 9 组" }],
    autoApprove: true,
    maxRounds: 60,
    onEvent: ev => resetting.push(ev),
  });
  check(
    eventsOf(resetting, "loop_warning") === 0 && eventsOf(resetting, "forced_decision") === 0 && reset.stopReason === "final",
    "每组都重置一次站点数据不算循环，也照旧算前进"
  );

  // 写脚本 → 跑 → 回看同样的 3 份样本：有重复，但每轮都有新脚本在跑，不该被停下。
  const iterating = [];
  const iterated = await run(
    scriptedClient({
      main: r => {
        const group = Math.ceil(r / 3);
        if (r > 36) {
          return done("## 结论\n第 12 版脚本通过");
        }
        return [
          toolCall("i" + r, "write_file", { path: `out/v${group}.js`, content: "v" + group }),
          toolCall("i" + r, "run_script", { n: group, pass: true }),
          toolCall("i" + r, "read_doc", { path: `sample-${group % 3}.txt`, offset: 0 }),
        ][(r - 1) % 3];
      },
    }),
    { maxRounds: 60, onEvent: ev => iterating.push(ev) }
  );
  check(
    eventsOf(iterating, "loop_warning") === 0 && iterated.stopReason === "final" && toolTexts(iterated).filter(t => t.includes("重复调用")).length === 9,
    "反复回看同几份样本会被逐次提示，但期间一直有新的写入和运行，不提醒、不停下"
  );

  // 真的在重做：同样的读取、搜索来回做，中间夹着同样的页面操作（操作本身不算，也冲淡不了重复）。
  const redoing = [];
  const redoSteps = [
    ["eval_page", { expr: "location.href" }],
    ["read_doc", { path: "a.js", offset: 0 }],
    ["read_doc", { path: "b.js", offset: 0 }],
    ["grep_code", { q: "sign" }],
    ["scroll", {}],
  ];
  const redo = await run(scriptedClient({ main: r => toolCall("d" + r, ...redoSteps[(r - 1) % 5]) }), {
    maxRounds: 80,
    onEvent: ev => redoing.push(ev),
  });
  check(
    eventsOf(redoing, "loop_warning") === 1 && redo.stopReason === "loop" && redo.rounds === 38,
    "从头重做（读取、搜索全是之前做过的）中间夹着页面操作，照样先提醒、再停下"
  );
}

console.log("循环检测：提醒不会丢，也不会过期了还作数");
{
  // 结果很大，提醒之后很快就压缩：重建的上下文里要有这条提醒。
  const bigCycle = r => toolCall("b" + r, "big_read", { n: ((r - 1) % 3) + 1 });
  const client = scriptedClient({ main: bigCycle, handoff: () => ({ content: "## 已确认事实\n- F", finishReason: "stop" }) });
  const result = await run(client, { maxRounds: 60 });
  check(result.stopReason === "loop" && result.rounds === 24 && client.log.handoff.length >= 2, "大结果的循环：提醒和停下之间压缩过");
  const afterWarning = client.log.main.slice(12);
  const seen = messages => userTexts(messages).some(t => t.includes("你最近的工具调用里有 9 次是之前做过的查询或读取"));
  check(afterWarning.length === 12 && afterWarning.every(seen), "提醒之后直到停下，每个请求里模型都看得到这条提醒");
  check(
    afterWarning.some(messages => messages.length === 4 && String(messages[3].content).includes("这次压缩之前已经提醒过你")),
    "压缩后提醒接在续跑说明后面"
  );
  check(seen(client.log.final[0]), "最后的汇报请求里也有");

  // 提醒之后模型换了做法（重复降到一半，但没完全恢复），很久以后又重复：重新提醒，不直接停。
  const events = [];
  const stale = await run(
    scriptedClient({
      main: r => {
        if (r <= 12 || (r >= 53 && r <= 56)) {
          return cycleCall(r);
        }
        if (r <= 52) {
          return r % 2 ? cycleCall(((r - 13) >> 1) + 1) : toolCall("s" + r, "grep_code", { q: "new-" + r });
        }
        return done("## 结论\n完成");
      },
    }),
    { maxRounds: 80, onEvent: ev => events.push(ev) }
  );
  check(
    eventsOf(events, "loop_warning") === 2 && eventsOf(events, "loop_stop") === 0 && stale.stopReason === "final",
    "提醒是 40 次计入的调用之前的事了：再重复时重新提醒，而不是按「提醒之后仍在重复」停下"
  );
}

console.log("循环检测：模型按提醒汇报就收尾");
{
  const client = scriptedClient({ main: r => (r <= 12 ? cycleCall(r) : done("已确认：签名在 x.js；卡在 b 的含义。")) });
  const result = await run(client, { maxRounds: 60 });
  check(result.stopReason === "final" && client.log.main.length === 13, "提醒后模型只回了一段汇报：本轮收尾，不再多发请求");
  check(userTexts(result.messages).every(t => !t.includes("别只描述计划")), "不把这段汇报当成漂移去催它调用工具");
  check(
    result.content.startsWith("已确认：签名在 x.js") && result.notice.includes("循环检测") && result.notice.includes("不再自动续跑"),
    "回复后面说明这是循环提醒之后的汇报，本轮已停下"
  );

  // 提醒之后模型接着干（发了新的调用），后面的纯文字回复照常判断。
  const later = scriptedClient({
    main: r =>
      r <= 12
        ? cycleCall(r)
        : r <= 15
          ? toolCall("w" + r, "grep_code", { q: "new-" + r })
          : r === 16
            ? done("接下来我打算分析 y.js 的导出。")
            : done("## 结论\n完成"),
  });
  const continued = await run(later, { maxRounds: 60 });
  check(
    userTexts(later.log.main[16]).some(t => t.includes("别只描述计划")) && continued.stopReason === "final" && !continued.notice,
    "提醒之后做过新的调用：之后只说计划不动手，照旧催它调用工具"
  );

  // 提醒那一轮不再叠「没明显推进」的提醒；之后换成别的没有进展的调用，这条提醒还会出现。
  const idle = scriptedClient({
    main: r => (r <= 12 ? cycleCall(r) : r <= 40 ? toolCall("z" + r, "read_doc", { path: "z.js", offset: r * 10 }) : done("## 结论\n没找到")),
  });
  const idled = await run(idle, { maxRounds: 60 });
  const reminders = userTexts(idled.messages).filter(t => t.startsWith("（系统·提醒）你已连续约"));
  check(reminders.length === 1, "循环提醒之后 12 次调用都没有进展：照常给一次「没明显推进」的提醒");
  check(userTexts(idle.log.main[12]).every(t => !t.startsWith("（系统·提醒）")), "循环提醒的那一轮不同时给两条提醒");

  // 等汇报的时候用户点了停止。
  const controller = new AbortController();
  const stopped = await run(
    scriptedClient({
      main: cycleCall,
      final: () => {
        controller.abort();
        return "汇报到一半";
      },
    }),
    { maxRounds: 60, signal: controller.signal }
  );
  check(stopped.stopReason === "aborted" && stopped.content === "（已手动停止）", "汇报请求期间手动停止：按手动停止收尾，不算循环停止");
}

console.log("跨回合（自动续跑）记着做过的调用");
{
  const runState = createRunState();
  const first = await run(scriptedClient({ main: () => toolCall("t1", "read_doc", { path: "a.js", offset: 0 }) }), {
    maxRounds: 1,
    runState,
  });
  check(first.stopReason === "max_rounds", "第一回合到轮数上限");
  const resumed = [...first.messages.filter(m => m.role !== "system"), { role: "user", content: "（系统·自动续跑）继续" }];
  const second = await run(
    scriptedClient({ main: r => (r === 1 ? toolCall("t2", "read_doc", { path: "a.js", offset: 0 }) : done("## 结论\nok")) }),
    { messages: resumed, runState }
  );
  check(toolTexts(second).at(-1).includes("重复调用"), "共用一份状态：续跑后的回合认得上一回合做过的调用");
  const fresh = await run(
    scriptedClient({ main: r => (r === 1 ? toolCall("t3", "read_doc", { path: "a.js", offset: 0 }) : done("## 结论\nok")) }),
    { messages: resumed }
  );
  check(!toolTexts(fresh).at(-1).includes("重复调用"), "不传状态时只在本回合内检测（行为和以前一致）");
  const partialState = await run(
    scriptedClient({ main: r => (r === 1 ? toolCall("t4", "read_doc", { path: "a.js", offset: 0 }) : done("## 结论\nok")) }),
    { messages: resumed, runState: { calls: new Map(), window: [], userNotes: [] } }
  );
  check(partialState.stopReason === "final" && !toolTexts(partialState).at(-1).includes("NaN"), "传进来的状态不完整（不是 createRunState 建的）就不用它");
}

console.log("无进展和失败判定看工具返回的 data");
{
  const reminded = result => userTexts(result.messages).some(t => t.includes("（系统·提醒）你已连续约"));
  const hits = await run(
    scriptedClient({ main: r => (r <= 14 ? toolCall("h" + r, "grep_code", { q: "q" + r }) : done("## 结论\nok")) })
  );
  check(!reminded(hits), "每次都搜到新结果算前进，14 次不同的搜索不会被提醒「没明显推进」");

  const saves = await run(
    scriptedClient({ main: r => (r <= 12 ? toolCall("w" + r, "save_thing", { n: r }) : done("## 结论\nok")) })
  );
  check(reminded(saves), "落盘类工具返回 { ok:false } 不算前进，12 次后提醒");

  // 6 次失败（每次报错的函数名和行号不同，同一类错）→ 1 次成功 → 再失败 1 次
  const scripts = await run(
    scriptedClient({
      main: r => (r <= 8 ? toolCall("f" + r, "run_script", { n: r, pass: r === 7 }) : done("## 结论\nok")),
    })
  );
  const texts = toolTexts(scripts);
  check(!texts[1].includes("撞同一类错误") && texts[2].includes("第 3 次用 run_script 撞同一类错误"), "脚本返回 { ok:false }：第 3 次同类错误提示换路线");
  check(!texts[4].includes("连续 5 次") && texts[5].includes("连续 6 次工具调用都失败了"), "连续 6 次失败给出提示");
  check(!texts[6].includes("⟪") && !texts[7].includes("连续"), "中间成功一次，连续失败计数清零");

  // 真实的进程输出：node 先回显出错的源码行，python 回溯里有 raise 那一行，脚本自己还可能先打印日志。
  // 真正的报错在最后；从头取第一条「像报错」的行，下面这些互不相干的失败会得到同一个签名。
  const nodeCrash = (n, message, type = "Error") =>
    `/w/case${n}.js:3\nthrow new ${type}("${message}");\n^\n\n${type}: ${message}\n    at Object.<anonymous> (/w/case${n}.js:3:7)\n` +
    `    at Module._compile (node:internal/modules/cjs/loader:1554:14)\n\nNode.js v24.21.0`;
  const pyCrash = (n, message) =>
    `Traceback (most recent call last):\n  File "/w/case${n}.py", line 3, in <module>\n    raise ValueError("${message}")\nValueError: ${message}`;
  const messages = ["签名长度不对", "nonce 为空", "时间戳超出范围", "编码表缺了一段"];
  const outputs = [
    ...messages.map((m, i) => nodeCrash(i, m)),
    ...messages.map((m, i) => "params: { token: undefined }\n" + nodeCrash(i + 4, m, "RangeError")),
    ...messages.slice(0, 3).map((m, i) => pyCrash(i, m)),
  ];
  const unrelated = await run(
    scriptedClient({
      main: r => (r <= outputs.length ? toolCall("u" + r, "run_script", { n: r, out: outputs[r - 1] }) : done("## 结论\nok")),
    })
  );
  check(toolTexts(unrelated).every(t => !t.includes("撞同一类错误")), "11 次互不相干的脚本失败（报错消息各不相同）不会被说成同一类错误");
  const sameError = await run(
    scriptedClient({
      main: r =>
        r <= 3 ? toolCall("e" + r, "run_script", { n: r, out: nodeCrash(r, "window is not defined", "ReferenceError") }) : done("## 结论\nok"),
    })
  );
  check(toolTexts(sameError)[2].includes("第 3 次用 run_script 撞同一类错误"), "同一个报错出现 3 次（出错位置不同）照样提示换路线");

  // 输出很大的失败：信封被截断后仍然看得出是失败。（projected 策略下单条结果折叠到 1.2 万字，6 条不会触发压缩。）
  const big = await run(scriptedClient({ main: r => (r <= 6 ? toolCall("x" + r, "big_fail", { n: r }) : done("## 结论\nok")) }), {
    contextStrategy: "projected",
  });
  check(
    big.toolCalls[0].env.data._truncated === true && big.toolCalls[0].env.data.ok === false,
    "返回值太大被截断时，信封里保留 ok:false"
  );
  check(toolTexts(big)[5].includes("连续 6 次工具调用都失败了"), "输出很大的失败照样计入连续失败");
}

console.log("压缩：交接摘要的输入和压缩后的上下文");
{
  const checkpoints = [];
  const factA = "## 已确认事实\n- FACT-A | 证据:big_read | 置信:高\n## 当前阶段 + 下一步\n- 下一步：big_read n=6";
  const truncatedLedger =
    "## 已确认事实\n" +
    [1, 2, 3, 4, 5, 6]
      .map(i => `- FACT-B${i} 签名第 ${i} 段的来源已确认 | 证据:big_read 返回的片段和页面请求里的值逐字节一致 | 置信:高`)
      .join("\n") +
    "\n## 已否决假设\n- DEAD-B 走 wasm → 导出表里没有\n- CUT-OFF 这一条没写完" +
    "细节".repeat(40);
  const client = scriptedClient({
    main: r => (r <= 11 ? toolCall("g" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成")),
    handoff: n => (n === 1 ? { content: factA, finishReason: "stop" } : { content: truncatedLedger, finishReason: "length" }),
  });
  const runState = createRunState();
  const result = await run(client, {
    messages: [
      { role: "user", content: "ORIGINAL-TASK：找出 x-sign 的生成函数，不要改页面" },
      { role: "assistant", content: "EARLIER-CONCLUSION：签名在 sign.js" },
      { role: "user", content: "补充：只用纯算，别补环境" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "继续" },
    ],
    runState,
    onCheckpoint: async (summary, info) => checkpoints.push({ summary, info }),
  });
  check(result.stopReason === "final" && client.log.handoff.length === 2, "两次压缩后正常收尾");

  const first = client.log.handoff[0];
  check(first.includes("MARK-5") && first.includes("STEP-1"), "第一次交接的输入里有最新一步（MARK-5），也有开头");
  check(first.includes("【当前任务（用户发的这条消息，原话）】\n继续"), "交接输入里单独列出当前任务");
  check(
    first.includes("【此前用户发过的消息（原话") && first.includes("1. ORIGINAL-TASK") && first.includes("2. 补充：只用纯算"),
    "此前用户发过的消息按先后列出原话，并注明可能是旧任务"
  );
  check(first.includes("【本轮之前的对话（节选）】") && first.includes("EARLIER-CONCLUSION"), "交接输入里有锚点之前的对话（前几轮的结论）");

  const afterFirst = client.log.main[5];
  check(afterFirst.length === 4 && afterFirst[1].content.startsWith("继续"), "压缩后的上下文还是 system + 任务 + 存档 + 续跑说明，任务是「继续」");
  check(afterFirst[2].role === "assistant" && afterFirst[2].content === factA, "存档是交接账本");
  const note = String(afterFirst[3].content);
  check(note.startsWith(NOTE_START), "续跑说明的正文不变");
  check(
    note.includes("1. ORIGINAL-TASK：找出 x-sign 的生成函数，不要改页面") && note.includes("2. 补充：只用纯算，别补环境"),
    "续跑说明后面附上用户此前的消息原文"
  );
  check(note.includes("仅供参考") && note.includes("已被用户取消的事不要重做"), "并说明这些消息只作参考：当前任务以任务消息为准，做完的、取消的不重做");
  check(!note.includes("继续\n") && !note.includes("3. "), "当前这条任务不重复列进去");

  const second = client.log.handoff[1];
  check(second.includes("【上一份进展存档】") && second.includes("FACT-A"), "第二次交接带上了上一份存档");
  check(second.includes("MARK-10") && second.includes("1. ORIGINAL-TASK"), "第二次交接有最新一步，也还有用户的原话");
  check(!second.includes("MARK-5") && !second.includes("【本轮之前的对话"), "第二次交接只总结上次压缩之后的执行记录");

  const partial = checkpoints[1].summary;
  check(
    partial.includes("FACT-B6") && partial.includes("## 交接账本超出长度被截断，以下是补充") && partial.includes("【进展存档·自动压缩】"),
    "交接账本被截断时保留已写出的部分，再补机械记录"
  );
  check(!partial.includes("CUT-OFF"), "被截断账本的最后一行只写了一半，不留");
  check(partial.includes("FACT-A") && !partial.includes("下一步：big_read n=6"), "补充里带上一份完整账本的结论，去掉当时的「下一步」");
  check(checkpoints[0].info.ledger === factA, "交给账本沉淀的是模型这一次写出来的账本");
  const merged = await ledgerItems(checkpoints[1].info.ledger);
  check(
    merged.length === 7 && merged.filter(i => i.kind === "fact").length === 6 && merged[6].kind === "deadend" && merged[6].text.includes("DEAD-B"),
    "被截断时只沉淀写完整的那几行：6 条事实、1 条已否决"
  );
  check(
    merged.every(i => !i.text.includes("CUT-OFF") && !i.text.includes("FACT-A") && !i.text.includes("STEP-")),
    "没写完的那条、带过来的旧账本、机械记录都不进账本库"
  );
  const afterSecond = client.log.main[10];
  check(String(afterSecond[3].content).includes("1. ORIGINAL-TASK"), "第二次压缩后续跑说明里仍有用户此前的消息");
  check(runState.epoch === 2 && runState.lastCheckpoint === partial, "状态里记着压缩次数和最近一份存档");
  check(
    runState.ledger === factA && runState.partial.includes("FACT-B6") && runState.records.length === 1,
    "状态里分开记着最近一份完整账本、之后那份没写完的，和这一段的机械记录"
  );

  // 模型的叙述一行就是一大段话，比留给开头的额度还长：截一段进来，开头不能因为「只留整行」整个丢掉。
  const wide = scriptedClient({
    main: r => (r <= 6 ? toolCall("w" + r, "big_read", { n: r }, `WIDE-${r} ` + "论述".repeat(9000)) : done("## 结论\n完成")),
    handoff: () => ({ content: factA, finishReason: "stop" }),
  });
  await run(wide);
  const wideSource = wide.log.handoff[0];
  check(
    wideSource.includes("[助手] WIDE-1 ") && wideSource.includes("MARK-5") && wideSource.includes("…（中间省略"),
    "执行记录里有超长的单行时，交接输入仍然留着开头和最新一步"
  );
}

/** 交接摘要没生成出来时的机械存档：先放一份上一次的账本，跑一次压缩，返回存档。 */
async function mechanicalCheckpoint(ledger, { messages, handoff } = {}) {
  const checkpoints = [];
  const runState = createRunState();
  runState.ledger = ledger;
  runState.lastCheckpoint = ledger;
  await run(
    scriptedClient({
      main: r => (r <= 6 ? toolCall("q" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成")),
      handoff: handoff || (() => ({ content: "", finishReason: "stop" })),
    }),
    { runState, ...(messages ? { messages } : {}), onCheckpoint: async (summary, info) => checkpoints.push({ summary, info }) }
  );
  assert.equal(checkpoints.length, 1);
  return { ...checkpoints[0], runState };
}

console.log("交接摘要没生成出来：机械存档不丢之前的内容");
{
  const checkpoints = [];
  const runState = createRunState();
  runState.ledger =
    "## 已确认事实\n- OLD-FACT 签名函数在 sign.js 第 120 行\n## 已否决假设\n- OLD-DEAD 走 wasm 的路不通 → 导出表里没有\n" +
    "## 当前阶段 + 下一步\n- 下一步：STALE-NEXT 读 sign.js 第 1 段";
  runState.lastCheckpoint = runState.ledger;
  const history = [];
  for (let i = 1; i <= 8; i++) {
    history.push({ role: "user", content: `USER-MSG-${i} ` + "字".repeat(1390) }, { role: "assistant", content: `ok-${i}` });
  }
  const client = scriptedClient({
    main: r =>
      r <= 11 ? toolCall("e" + r, "big_read", { n: r }, longStep(r, `\n- NARRATION-BULLET-${r} 我打算试试 bar`)) : done("## 结论\n完成"),
    handoff: () => ({ content: "", finishReason: "stop" }),
  });
  const result = await run(client, {
    messages: [...history, { role: "user", content: "继续" }],
    runState,
    onCheckpoint: async (summary, info) => checkpoints.push({ summary, info }),
  });
  check(result.stopReason === "final" && checkpoints.length === 2, "压缩两次后收尾，两次交接摘要都没生成出来");
  const summary = checkpoints[0].summary;
  check(summary.includes("OLD-FACT") && summary.includes("OLD-DEAD") && summary.includes("big_read×5"), "机械存档里有上一份账本的结论和这一段的工具记录");
  check(!summary.includes("STALE-NEXT"), "上一份账本里过时的「下一步」不带进新存档");
  check(summary.includes("## 这条任务之前的对话结尾（引用原文，不是结论）") && summary.includes("USER-MSG-8"), "带上锚点之前对话的结尾");
  check(summary.includes("NARRATION-BULLET-5"), "机械记录里有最近的叙述");
  check(checkpoints[0].info.ledger === "" && checkpoints[1].info.ledger === "", "机械存档没有可沉淀的内容：交给账本库的是空的");
  const again = checkpoints[1].summary;
  check(
    again.includes("OLD-FACT") && again.includes("OLD-DEAD") && again.includes("NARRATION-BULLET-10") && !again.includes("STALE-NEXT"),
    "连续第二次机械存档里，最早那份账本的结论还在"
  );
  check(again.includes("## 更早几段的机械记录") && again.includes("NARRATION-BULLET-5"), "上一段的机械记录也带着");
  const note = String(client.log.main[5][3].content);
  check(
    note.includes("1. USER-MSG-5 ") && note.includes("4. USER-MSG-8 ") && !note.includes("USER-MSG-4 ") && !note.includes("USER-MSG-1 "),
    "用户此前的消息只带最近 4 条，更早的（多半是别的任务）不带"
  );
}

console.log("机械存档：带上的账本不截半句，连续几次也不越带越少");
{
  // 账本超过带上的上限：只在行与行之间截。
  const facts = Array.from({ length: 60 }, (_, i) => `- FACT-${i + 1} 接口 /api/v${i + 1}/list 的签名输入是 url+ts+nonce，输出 32 位十六进制；` + "细节".repeat(130));
  const deadEnds = Array.from({ length: 5 }, (_, i) => `- DEAD-${i + 1} 试过方案 ${i + 1} → 走不通`);
  const longLedger = `## 已确认事实\n${facts.join("\n")}\n## 已否决假设\n${deadEnds.join("\n")}`;
  const clipped = await mechanicalCheckpoint(longLedger);
  const carriedFacts = clipped.summary.split("\n").filter(line => line.startsWith("- FACT-"));
  check(
    carriedFacts.length > 20 && carriedFacts.length < 60 && carriedFacts.every(line => facts.includes(line)),
    "账本太长被截开时，留下的每一条都是完整的原文，没有半句"
  );
  check(/\n## …（中间省略 \d+ 行）…\n/.test(clipped.summary) && clipped.summary.includes("DEAD-5 "), "省略的地方标出略了几行（标题形式），排在最后的已否决假设还在");

  // 一份正常长度的账本（已否决假设、文件清单排在后面），之后连续三次交接摘要都没生成出来。
  const ledger =
    "## 目标定义\n- 还原 x-sign\n## 已确认事实\n" +
    Array.from({ length: 30 }, (_, i) => `- OLD-FACT-${i + 1} ` + "已核对".repeat(40)).join("\n") +
    "\n## 已否决假设\n" +
    Array.from({ length: 14 }, (_, i) => `- OLD-DEAD-${i + 1} ` + "走不通".repeat(30)).join("\n") +
    "\n## 工作目录文件\n" +
    Array.from({ length: 8 }, (_, i) => `- OLD-FILE-${i + 1} out/part-${i + 1}.js`).join("\n") +
    "\n## 当前阶段 + 下一步\n- 下一步：STALE-NEXT";
  const checkpoints = [];
  const runState = createRunState();
  runState.ledger = ledger;
  runState.lastCheckpoint = ledger;
  await run(
    scriptedClient({
      main: r => (r <= 16 ? toolCall("j" + r, "big_read", { n: r }, longStep(r, `\n发现 FIND-${r}`)) : done("## 结论\n完成")),
      handoff: () => {
        throw new Error("503 Service Unavailable");
      },
    }),
    { runState, onCheckpoint: async (summary, info) => checkpoints.push({ summary, info }) }
  );
  check(
    checkpoints.length === 3 &&
      checkpoints.every(c => c.summary.includes("OLD-FACT-30 ") && c.summary.includes("OLD-DEAD-14 ") && c.summary.includes("OLD-FILE-8 ")),
    "连续三次机械存档：账本里排在后面的已否决假设和文件清单每次都完整带着"
  );
  check(checkpoints.every(c => !c.summary.includes("STALE-NEXT") && c.info.ledger === ""), "过时的「下一步」每次都不带，也都不往账本库里交");
  const third = checkpoints[2].summary;
  check(
    third.includes("### 第 1 段") && third.includes("### 第 2 段") && third.includes("FIND-5") && third.includes("FIND-10") && third.includes("FIND-15"),
    "前两段的机械记录还在第三份存档里"
  );
  check(third.split("之前的交接账本").length === 2, "带上的是账本原文，不是上一份存档整份再套一层");

  // 连续两次被长度截断，再一次没生成出来。
  const partialOf = n =>
    "## 已确认事实\n" +
    Array.from({ length: 8 }, (_, i) => `- NEW-FACT-${n}-${i + 1} 第 ${n} 段新确认的第 ${i + 1} 条 | 证据:big_read 的返回片段 | 置信:高`).join("\n") +
    "\n- 没写完的一条";
  const truncated = [];
  const truncatedState = createRunState();
  truncatedState.ledger = ledger;
  truncatedState.lastCheckpoint = ledger;
  await run(
    scriptedClient({
      main: r => (r <= 16 ? toolCall("y" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成")),
      handoff: n => (n <= 2 ? { content: partialOf(n), finishReason: "length" } : { content: "", finishReason: "stop" }),
    }),
    { runState: truncatedState, onCheckpoint: async (summary, info) => truncated.push({ summary, info }) }
  );
  check(
    truncated.length === 3 && truncated.slice(0, 2).every((c, i) => c.summary.startsWith("## 已确认事实\n- NEW-FACT-" + (i + 1)) && c.summary.includes("OLD-DEAD-14 ")),
    "连续两次被截断：每次都是这次写出的部分在前，没写到的已否决假设用上一份完整账本补上"
  );
  check(
    truncated[2].summary.includes("## 之后一份没写完的交接账本") &&
      truncated[2].summary.includes("NEW-FACT-2-8") &&
      !truncated[2].summary.includes("NEW-FACT-1-8") &&
      truncated[2].summary.includes("OLD-DEAD-14 "),
    "之后摘要没生成出来：带上完整账本和最近那份没写完的账本"
  );
}

console.log("机械存档：过时的「下一步」认得出各种写法");
{
  const stale = [
    "## 当前阶段 + 下一步",
    "### 下一步",
    "## 5. 当前阶段 + 下一步",
    "## **当前阶段 + 下一步**",
    "## 🚩 当前阶段与下一步",
    "##当前阶段+下一步",
    "## 阶段与下一步",
    "## 五、下一步",
    "## （5）下一步计划",
  ];
  const kept = [];
  for (const heading of stale) {
    const { summary } = await mechanicalCheckpoint(
      `## 已确认事实\n- KEEP-FACT\n${heading}\n- 下一步：STALE-NEXT big_read n=6\n#### 退出标准\n- STALE-SUB`
    );
    if (summary.includes("KEEP-FACT") && !summary.includes("STALE-NEXT") && !summary.includes("STALE-SUB")) {
      kept.push(heading);
    }
  }
  check(kept.length === stale.length, "标题带序号、加粗、表情、没有空格、换了说法，这一节（连同里面的小节）都能去掉");
  const crlf = await mechanicalCheckpoint("## 已确认事实\r\n- KEEP-FACT\r\n## 当前阶段 + 下一步\r\n- 下一步：STALE-NEXT\r\n");
  check(crlf.summary.includes("KEEP-FACT") && !crlf.summary.includes("STALE-NEXT"), "CRLF 换行的账本也一样");
  const middle = await mechanicalCheckpoint("## 下一步\n- STALE-NEXT\n## 工作目录文件\n- KEEP-FILE out/a.js\n## 阶段性结论\n- KEEP-STAGE");
  check(
    !middle.summary.includes("STALE-NEXT") && middle.summary.includes("KEEP-FILE") && middle.summary.includes("KEEP-STAGE"),
    "只去掉这一节：后面的节、标题里只是带「阶段」二字的节都留着"
  );
  const fenced = await mechanicalCheckpoint("## 已确认事实\n- KEEP-FACT\n```bash\n# 下一步：安装依赖\nnpm ci\n```\n- KEEP-AFTER-FENCE");
  check(fenced.summary.includes("npm ci") && fenced.summary.includes("KEEP-AFTER-FENCE"), "代码块里以 # 开头的注释不是标题，后面的内容不会被一起删掉");
}

console.log("机械存档：引用的对话不会被当成结论");
{
  const dialogue = [
    { role: "user", content: "分析 genSign" },
    { role: "assistant", content: "有两条路，你选一个：\n### 已否决\n- 方向 A：补环境实跑\n- 方向 B：纯算还原 genSign" },
    { role: "user", content: "走方向 B" },
  ];
  const { summary, info } = await mechanicalCheckpoint("", {
    messages: dialogue,
    handoff: () => {
      throw new Error("timeout");
    },
  });
  check(summary.includes("> - 方向 B：纯算还原 genSign") && summary.includes("> ### 已否决"), "任务之前的对话作为引用带上（每行前面有 > ）");
  check(info.ledger === "", "交给账本库的内容是空的");
  check((await ledgerItems(summary)).length === 0, "就算把整份存档交给账本库，对话里的标题和列表也不会被记成已否决");

  // 同样的话又说了一遍：算最新的那次。
  const repeated = await mechanicalCheckpoint("", {
    messages: [
      { role: "user", content: "要求 X：只用纯算" },
      { role: "assistant", content: "好" },
      { role: "user", content: "要求 Y：可以补环境" },
      { role: "assistant", content: "好" },
      { role: "user", content: "要求 X：只用纯算" },
      { role: "assistant", content: "好" },
      { role: "user", content: "继续" },
    ],
  });
  check(
    repeated.runState.userNotes.length === 2 && repeated.runState.userNotes[0].startsWith("要求 Y") && repeated.runState.userNotes[1].startsWith("要求 X"),
    "用户把同一句话又说了一遍：按最后一次的位置排，最新的要求在最后"
  );

  // 之前有一条任务被用户手动停止过：原话后面注明，之后发的别的任务不带这个标记。
  const cancelled = await mechanicalCheckpoint("", {
    messages: [
      { role: "user", content: "任务 A：必须补环境实跑，产物写到 work/a.js" },
      { role: "assistant", content: "（已手动停止）" },
      { role: "user", content: "任务 B：只看 b.js 的导出" },
      { role: "assistant", content: "## 结论\nb.js 导出 3 个函数" },
      { role: "user", content: "继续" },
    ],
  });
  check(
    cancelled.runState.userNotes.length === 2 &&
      cancelled.runState.userNotes[0] === "任务 A：必须补环境实跑，产物写到 work/a.js\n（发出这条消息之后，任务被用户手动停止过）" &&
      cancelled.runState.userNotes[1] === "任务 B：只看 b.js 的导出",
    "被用户手动停止过的任务，原话后面注明；别的消息不带这个标记"
  );

  // 用户原话很长、带 emoji：截断不能留下半个字符。
  const emoji = "a" + "🔥".repeat(1200);
  const requests = [];
  const client = scriptedClient({
    main: (r, messages) => {
      requests.push(messages);
      return r <= 6 ? toolCall("m" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成");
    },
    handoff: () => ({ content: "## 已确认事实\n- F", finishReason: "stop" }),
  });
  await run(client, { messages: [{ role: "user", content: emoji }, { role: "assistant", content: "好" }, { role: "user", content: "开始采集" }] });
  const strings = [...client.log.handoff, ...requests.flat().map(m => (typeof m.content === "string" ? m.content : ""))];
  check(strings.every(text => text.isWellFormed()), "带 emoji 的长消息被截短后没有半个字符（孤立代理项）");
  check(String(client.log.main[5][3].content).includes("🔥") && client.log.handoff[0].includes("🔥"), "截短后的原话还在续跑说明和交接输入里");

  // 写摘要的时候用户点了停止。
  const controller = new AbortController();
  const checkpoints = [];
  const stopped = await run(
    scriptedClient({
      main: r => toolCall("s" + r, "big_read", { n: r }, longStep(r)),
      handoff: () => {
        controller.abort();
        throw new Error("aborted");
      },
    }),
    { signal: controller.signal, onCheckpoint: async summary => checkpoints.push(summary) }
  );
  check(stopped.stopReason === "aborted" && checkpoints.length === 0, "写交接摘要时手动停止：不再压缩、不落存档，按手动停止收尾");
}

console.log("账本的自动沉淀：只增不减，新结论不被旧条目挤掉");
{
  /** 接了内存表的 LedgerBackend：只实现它用到的那几条语句的语义（语句文本由 selftest-ledger-sql 守着）。 */
  const memoryLedger = () => {
    const rows = [];
    const log = { inserts: 0, deletes: 0 };
    let nextId = 1;
    const result = list => list.map(row => ({ getResultByName: name => row[name] }));
    const db = {
      async execute(sql, params) {
        if (sql.startsWith("SELECT id,norm FROM mem")) {
          return result(rows.filter(r => r.kind === params.k && r.workspace === params.v));
        }
        if (sql.startsWith("SELECT kind,text,ev FROM mem")) {
          return result(rows.filter(r => r.workspace === params.v));
        }
        if (sql.startsWith("INSERT INTO mem")) {
          rows.push({ id: nextId++, kind: params.k, workspace: params.w, text: params.t, ev: params.e, norm: params.n });
          log.inserts++;
          return [];
        }
        if (sql.startsWith("DELETE FROM mem WHERE id IN (SELECT")) {
          const newestFirst = rows.filter(r => r.kind === params.k && r.workspace === params.v).sort((a, b) => b.id - a.id);
          for (const row of newestFirst.slice(params.cap)) {
            rows.splice(rows.indexOf(row), 1);
          }
          return [];
        }
        if (sql.startsWith("DELETE FROM mem WHERE id IN (")) {
          for (const id of params) {
            rows.splice(rows.findIndex(r => r.id === id), 1);
            log.deletes++;
          }
          return [];
        }
        throw new Error("unexpected SQL: " + sql);
      },
    };
    const ledger = new LedgerBackend();
    ledger._db = async () => db;
    ledger._renderMd = async () => {};
    ledger.currentSite = () => "";
    return { ledger, rows, log, ctx: { workspaceRoot: "/ws" } };
  };
  const texts = (rows, kind) => rows.filter(r => r.kind === kind).map(r => r.text);

  // 交接账本逐次累积：每段新确认 8 条事实、否决 3 条假设，旧的照抄在前、新的接在后。
  const growing = memoryLedger();
  const fact = i => `FACT-${i} 第 ${i} 条已确认的结论，带着具体的值 0x${(i * 4099).toString(16)} | 证据:big_read | 置信:高`;
  const dead = i => `DEAD-${i} 第 ${i} 条已否决的方向 → 返回值对不上`;
  for (let segment = 1; segment <= 8; segment++) {
    const facts = Array.from({ length: segment * 8 }, (_, i) => "- " + fact(i + 1));
    const deadEnds = Array.from({ length: segment * 3 }, (_, i) => "- " + dead(i + 1));
    await growing.ledger.mergeHandoff(`## 已确认事实\n${facts.join("\n")}\n## 已否决假设（永不重试）\n${deadEnds.join("\n")}`, growing.ctx);
  }
  check(
    texts(growing.rows, "fact").length === 64 && texts(growing.rows, "deadend").length === 24,
    "8 次压缩后 64 条事实、24 条已否决假设全部入库（以前账本过了 40 条，后面的就进不去了）"
  );
  check(growing.log.inserts === 88 && growing.log.deletes === 0, "已经入库的条目不再删掉重插");
  const ids = growing.rows.map(r => r.id).join(",");
  const again = await growing.ledger.mergeHandoff(
    `## 已确认事实\n${Array.from({ length: 64 }, (_, i) => "- " + fact(i + 1)).join("\n")}`,
    growing.ctx
  );
  check(again.added === 0 && again.unchanged === 64 && growing.rows.map(r => r.id).join(",") === ids, "同一份账本再沉淀一次：什么都不动，先后顺序不变");

  // 库里是完整的一条，自动沉淀抽到的是它的一部分：不能拿半句顶掉完整的。
  const complete = memoryLedger();
  const full = "FACT-26 接口 /api/v26/list 的签名输入是 url+ts+nonce，输出 32 位十六进制 | 证据:run_node 对照 | 置信:高";
  await complete.ledger.append({ text: full, evidence: "run_node 三组样本" }, complete.ctx);
  const fragment = await complete.ledger.mergeHandoff("## 已确认事实\n- FACT-26 接口 /api/v26/list 的签名输入是 url", complete.ctx);
  check(
    fragment.unchanged === 1 && texts(complete.rows, "fact").join("|") === full && complete.rows[0].ev === "run_node 三组样本",
    "库里已有更完整的一条：自动沉淀抽到的半句不会顶掉它，证据也还在"
  );
  const longer = "x-sign 是 md5(path+ts)，再拼 salt=9f8e7d6c 后取前 16 位 | 证据:run_node 对照 | 置信:高";
  await complete.ledger.append({ text: "x-sign 是 md5(path+ts)" }, complete.ctx);
  await complete.ledger.mergeHandoff(`## 已确认事实\n- ${longer}`, complete.ctx);
  check(
    texts(complete.rows, "fact").includes(longer) && !texts(complete.rows, "fact").includes("x-sign 是 md5(path+ts)"),
    "新的一条更完整（包含旧的）：换成新的"
  );
  await complete.ledger.append({ text: "FACT-26 接口 /api/v26/list 的签名输入是 url+ts+nonce" }, complete.ctx);
  check(
    !texts(complete.rows, "fact").includes(full) && texts(complete.rows, "fact").includes("FACT-26 接口 /api/v26/list 的签名输入是 url+ts+nonce"),
    "模型自己用 remember 改了说法：照旧以新的为准（删旧留新）"
  );

  // 一份账本里一下子有很多新条目：每类一次最多写入 40 条，剩下的下次再进。
  const flood = memoryLedger();
  const floodText =
    "## 已确认事实\n" +
    Array.from({ length: 50 }, (_, i) => "- " + fact(i + 1)).join("\n") +
    "\n- " + fact(1) +
    "\n## 已否决假设\n" +
    Array.from({ length: 50 }, (_, i) => "- " + dead(i + 1)).join("\n");
  await flood.ledger.mergeHandoff(floodText, flood.ctx);
  check(
    texts(flood.rows, "fact").length === 40 && texts(flood.rows, "deadend").length === 40,
    "一次沉淀每类最多新写入 40 条，事实再多也不占已否决假设的名额"
  );
  await flood.ledger.mergeHandoff(floodText, flood.ctx);
  check(texts(flood.rows, "fact").length === 50 && texts(flood.rows, "deadend").length === 50, "剩下的下一次压缩时入库");
}

console.log("自动续跑的回合：任务锚点还是用户发的任务");
{
  const step = n => `STEP-${n} ` + "分析".repeat(2000);
  const runState = createRunState();
  const turnOne = scriptedClient({ main: r => toolCall("a" + r, "big_read", { n: r }, step(r)) });
  const first = await run(turnOne, {
    runState,
    dynamicContext: "ctx=1",
    messages: [{ role: "user", content: "REAL-TASK：分析 sign 参数" }],
    maxRounds: 3,
  });
  check(first.stopReason === "max_rounds", "第一回合到轮数上限，没有压缩过");
  const auto = "（系统·自动续跑）上一段到达轮次/调用上限但任务还没完成。继续推进到底。";
  const resumed = [...first.messages.filter(m => m.role !== "system"), { role: "user", content: auto }];
  const client = scriptedClient({
    main: r => (r <= 4 ? toolCall("b" + r, "big_read", { n: r + 3 }, step(r + 3)) : done("## 结论\n完成")),
    handoff: () => ({ content: "## 已确认事实\n- FACT-RESUME", finishReason: "stop" }),
  });
  // 账本在上一回合多记了一条：这一回合的动态上下文变了。
  const second = await run(client, { runState, dynamicContext: "ctx=2", messages: resumed });
  check(second.stopReason === "final" && client.log.handoff.length === 1, "第二回合压缩一次后收尾");
  const firstRequest = client.log.main[0];
  const lastOfTurnOne = turnOne.log.final[0];
  check(
    JSON.stringify(firstRequest.slice(0, lastOfTurnOne.length)) === JSON.stringify(lastOfTurnOne),
    "续跑回合的第一个请求，前面和上一回合最后一个请求逐字节相同（服务端的前缀缓存接得上）"
  );
  check(
    firstRequest[1].content.startsWith("REAL-TASK") && firstRequest[1].content.includes("ctx=1") && !firstRequest[1].content.includes("ctx=2"),
    "任务消息原样不动，上一回合附的动态上下文还在"
  );
  check(
    firstRequest.at(-1).content.startsWith(auto) && firstRequest.at(-1).content.includes("ctx=2"),
    "变了的动态上下文附在最后一条消息（续跑提示）后面"
  );
  const source = client.log.handoff[0];
  check(source.includes("MARK-1") && source.includes("MARK-6") && source.includes("（系统·自动续跑）"), "压缩时上一回合的工作在执行记录里，一起总结");
  check(!source.includes("FRX_RUNTIME_CONTEXT") && !source.includes("ctx=2"), "动态上下文块不进交接摘要的输入");
  check(
    source.includes("【当前任务（用户发的这条消息，原话）】\nREAL-TASK：分析 sign 参数") && !source.includes("【本轮之前的对话"),
    "当前任务是用户的任务"
  );
  const afterCompaction = client.log.main[3];
  check(
    afterCompaction.length === 4 && afterCompaction[1].content.startsWith("REAL-TASK") && afterCompaction[2].content.includes("FACT-RESUME"),
    "压缩后的上下文是 system + 用户的任务 + 存档 + 续跑说明"
  );
  check(
    afterCompaction[1].content.includes("ctx=2") && !afterCompaction[1].content.includes("ctx=1"),
    "压缩后任务消息上只有最新的一份动态上下文"
  );
  check(userTexts(afterCompaction).every(t => !t.includes("自动续跑")), "续跑提示已经总结进存档，不再留在上下文里");

  // 动态上下文没变：续跑提示后面不再附一份。
  const steady = createRunState();
  const one = await run(scriptedClient({ main: r => toolCall("p" + r, "read_doc", { path: "p.js", offset: r }) }), {
    runState: steady,
    dynamicContext: "ctx=1",
    messages: [{ role: "user", content: "REAL-TASK" }],
    maxRounds: 2,
  });
  const next = scriptedClient({ main: () => done("## 结论\nok") });
  await run(next, { runState: steady, dynamicContext: "ctx=1", messages: [...one.messages.filter(m => m.role !== "system"), { role: "user", content: auto }] });
  check(next.log.main[0].at(-1).content === auto, "动态上下文没变时不重复附加");

  const detached = scriptedClient({ main: () => done("## 结论\nok") });
  await run(detached, { dynamicContext: "ctx=1", messages: resumed });
  check(
    detached.log.main[0].at(-1).content.includes("ctx=1") && !detached.log.main[0][1].content.includes("ctx="),
    "不共用状态时退回取最后一条 user 消息，旧消息上的动态上下文去掉（行为和以前一致）"
  );
}

console.log("请求体里不留半个字符");
{
  const broken = "前半" + "🔥".slice(0, 1) + "后半" + "🔥".slice(1) + "完整的🔥";
  const configs = [
    { protocol: PROTOCOLS.OPENAI, baseUrl: "https://example.test/v1" },
    { protocol: PROTOCOLS.OPENAI_RESPONSES, baseUrl: "https://example.test" },
    { protocol: PROTOCOLS.ANTHROPIC, baseUrl: "https://example.test" },
    { protocol: PROTOCOLS.GEMINI, baseUrl: "https://example.test" },
  ];
  const clean = configs.every(config => {
    const body = new LlmClient({ ...config, apiKey: "k", model: "m" }).buildRequest([
      { role: "system", content: "sys" },
      { role: "user", content: broken },
    ]).init.body;
    return !/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(body) && body.includes("完整的🔥");
  });
  check(clean, "四种协议的请求体里，孤立代理项都换成了 U+FFFD，完整的 emoji 不受影响");
}

console.log("AgentSession：一次执行共用一份状态，停下的原因看得见");
{
  const created = [];
  const seen = [];
  const replies = [];
  const persisted = [];
  const merged = [];
  const session = await loadAgentSession({
    configStore: { getGlobalSystemPrompt: () => "", getContextStrategy: () => "projected" },
    conversationStore: { appendMessage: async (id, message) => persisted.push(message) },
    backends: {
      workspace: { write: async () => ({}) },
      ledger: { digest: async () => "", mergeHandoff: async text => merged.push(text) },
    },
    agentLoop: {
      createRunState() {
        const state = { calls: new Map(), id: created.length + 1 };
        created.push(state);
        return state;
      },
      async runAgentTurn(options) {
        seen.push(options.runState);
        const reply = replies.shift() || { content: "done", stopReason: "final", messages: [] };
        return typeof reply === "function" ? reply(options) : reply;
      },
    },
  });
  const runOnce = () =>
    session.run("loop-thread", { systemPrompt: "sys", convo: [{ role: "user", content: "task" }], workspaceRoot: "/ws" });
  const lastText = () => {
    const steps = persisted.at(-1).steps || [];
    return steps.filter(s => s.kind === "text").map(s => s.text).join("\n");
  };

  replies.push({ content: "到上限", stopReason: "max_rounds", messages: [] }, { content: "完成", stopReason: "final", messages: [] });
  await runOnce();
  check(seen.length === 2 && seen[0] === seen[1] && seen[0].id === 1, "自动续跑的两个回合拿到同一份状态");
  await runOnce();
  check(seen.length === 3 && seen[2].id === 2, "用户再发起一次执行时换一份新的");

  const loopNotice = "（系统）⚠ 检测到循环：提醒之后，模型最近的工具调用里仍有 12 次是之前做过、结果完全相同的查询。";
  replies.push(options => {
    options.onEvent({ type: "tool_call", id: "t1", name: "read_doc" });
    options.onEvent({ type: "tool_result", id: "t1", env: { ok: true, data: {} } });
    options.onDelta("模型的汇报");
    return { content: "模型的汇报\n\n---\n" + loopNotice, notice: loopNotice, stopReason: "loop", messages: [] };
  });
  await runOnce();
  check(seen.length === 4 && session.getState("loop-thread").content.includes("检测到循环"), "stopReason=loop 不自动续跑，结果照常落盘");
  check(
    lastText().startsWith("模型的汇报") && lastText().includes(loopNotice),
    "停下的原因接在模型的汇报后面，成为步骤记录里的一段正文（侧栏有步骤时只渲染步骤）"
  );

  replies.push(options => {
    options.onEvent({ type: "tool_call", id: "t2", name: "read_doc" });
    options.onEvent({ type: "tool_result", id: "t2", env: { ok: true, data: {} } });
    return { content: loopNotice, notice: loopNotice, stopReason: "loop", messages: [] };
  });
  await runOnce();
  check(lastText() === loopNotice, "模型没写汇报时，停下的原因单独成为一段正文");

  const drift = "（系统）⚠ 模型连续多次只输出文字计划、不调用工具就停了。";
  replies.push(
    { content: "计划一\n\n---\n" + drift, notice: drift, stopReason: "drift", messages: [] },
    options => {
      options.onDelta("计划二");
      return { content: "计划二\n\n---\n" + drift, notice: drift, stopReason: "drift", messages: [] };
    }
  );
  await runOnce();
  check(lastText().includes(drift) && lastText().includes("连续两轮只在描述/分析"), "连续两轮漂移停下时，模型侧的原因和不再续跑的说明都看得见");

  replies.push(async options => {
    await options.onCheckpoint("整份存档（带机械记录）", { ledger: "## 已确认事实\n- 这一次写出来的" });
    await options.onCheckpoint("机械存档", { ledger: "" });
    await options.onCheckpoint("旧调用方只给存档");
    return { content: "完成", stopReason: "final", messages: [] };
  });
  await runOnce();
  check(
    merged.length === 2 && merged[0] === "## 已确认事实\n- 这一次写出来的" && merged[1] === "旧调用方只给存档",
    "压缩时只把模型这一次写出来的账本交给账本库；没有可沉淀的内容就不交"
  );
}

console.log(`\nLoop guard selftest: ${pass} passed`);
