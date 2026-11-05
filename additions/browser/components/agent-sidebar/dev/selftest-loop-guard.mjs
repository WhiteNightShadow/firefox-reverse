/* dev/selftest-loop-guard.mjs — 长任务忘了结论、从头重做、绕圈（#5）。
 *   - 压缩：交接摘要能看到最新的执行记录、用户的原话、锚点之前的对话和上一份存档；压缩后用户此前的消息还在；
 *     交接摘要被截断或没生成出来时，不把之前确认过的内容丢掉，也不把过时的「下一步」带进新存档；
 *   - 自动续跑的回合里任务锚点还是用户发的那条任务，压缩时上一回合的工作不会被当成历史丢掉；
 *   - 重复调用提示；跨压缩、跨自动续跑的循环检测：先提醒，提醒后仍在重复就停下本轮（stopReason=loop）；
 *   - A2 的结果指纹、无进展判定、失败判定都看工具返回的 data：分页读文件不再被误熔断，
 *     工具返回 { ok:false } 也算失败；
 *   - AgentSession 一次执行的所有回合共用一份状态。
 * 不调用真实模型，不启动浏览器。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { createRunState, runAgentTurn } from "../modules/AgentLoop.sys.mjs";
import { LedgerBackend } from "../modules/LedgerBackend.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { emptyUsage, mergeUsage, normalizeUsage } from "../modules/Usage.sys.mjs";

let pass = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  pass++;
  console.log("  ✓", message);
};

/** 按脚本回复的假模型：交接摘要请求、收尾请求（轮数用尽的不带工具；循环检测停下时的带工具、但要求不再调用）、
 *  带工具的主请求分开处理。未超预算时 trimContext 原样返回 msgs，之后还会被追加，所以记录时先拍快照。 */
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
      const report = !!last && last.role === "user" && String(last.content).includes("不要再调用工具");
      if (!opts.tools || report) {
        log.final.push(messages.slice());
        log.finalOpts.push(opts);
        return { content: final ? final(messages) : "## 结论\n收尾", finishReason: "stop", toolCalls: [] };
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

/** 真实 ToolRouter（信封是 { ok, data }），几个确定性的假工具。 */
function makeRouter() {
  const router = new ToolRouter();
  router.registerAll([
    { name: "read_doc", handler: async ({ path, offset = 0 }) => ({ content: `${path}@${offset}` }) },
    { name: "grep_code", handler: async ({ q }) => ({ hits: [{ line: 1, text: String(q) }] }) },
    { name: "scroll", repeatExempt: true, handler: async () => ({ moved: true }) },
    { name: "big_read", handler: async ({ n }) => ({ text: `MARK-${n} ` + "x".repeat(40000) }) },
    // 像 run_node：脚本失败时不抛错，返回 { ok:false, exitCode, output }。
    {
      name: "run_script",
      repeatExempt: true,
      handler: async ({ n, pass: ok }) =>
        ok
          ? { ok: true, exitCode: 0, output: "done" }
          : { ok: false, exitCode: 1, output: `TypeError: fn_${n} is not a function\n    at run (/w/a${n}.js:${n}:5)` },
    },
    { name: "save_thing", progress: true, handler: async ({ n }) => ({ ok: false, error: `disk full ${n}` }) },
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
/** 账本自动沉淀会从存档里认出哪些条目（不碰 SQLite）。 */
async function ledgerItems(summary) {
  const ledger = new LedgerBackend();
  let items = [];
  ledger._addMany = async list => {
    items = list;
    return { added: list.length, dedup: 0 };
  };
  await ledger.mergeHandoff(summary, {});
  return items;
}
const NOTE_START = "（上面是你已完成的【进展存档】";
const longStep = (n, extra = "") => `STEP-${n} ` + "分析".repeat(6000) + extra;

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
  check(sameTexts[1].includes("重复调用") && sameTexts[1].includes("1 次"), "第二次相同调用就带上重复提示");
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
          done("## 结论\nok"),
        ][r - 1],
    })
  );
  const texts = toolTexts(result);
  check(!texts[0].includes("重复调用") && texts[1].includes("重复调用"), "参数键顺序不同也认得是同一个调用");
  check(!texts[3].includes("重复调用"), "豁免重复的工具（滚动）不提示");
}

console.log("循环检测：提醒后仍重复就停下");
{
  const cycle = [
    ["grep_code", { q: "a" }],
    ["grep_code", { q: "b" }],
    ["read_doc", { path: "x.js", offset: 0 }],
  ];
  const events = [];
  const client = scriptedClient({
    main: r => {
      const [name, args] = cycle[(r - 1) % cycle.length];
      return toolCall("l" + r, name, args);
    },
    final: () => "已确认：签名在 x.js；卡在 b 的含义。",
  });
  const result = await run(client, { maxRounds: 60, onEvent: ev => events.push(ev) });
  const warned = client.log.main.findIndex(messages =>
    messages.some(m => m.role === "user" && String(m.content).startsWith("（系统·循环检测）最近 12 次"))
  );
  check(warned === 12, "第 12 次调用后注入循环提醒（9 次是之前做过、结果相同的）");
  check(events.some(e => e.type === "loop_warning") && events.some(e => e.type === "loop_stop"), "发出 loop_warning 和 loop_stop 事件");
  check(result.stopReason === "loop" && result.rounds === 24, "提醒之后又重复满一个窗口，在第 24 轮停下，stopReason=loop");
  check(result.content.includes("签名在 x.js") && result.content.includes("检测到循环"), "停下时先让模型汇报，再附上停下的原因");
  check(!result.content.includes('{"q"'), "给用户看的停止说明只列工具名，不带参数");
  check(client.log.final.length === 1 && Array.isArray(client.log.finalOpts[0].tools), "汇报请求照样带工具声明，只是明确要求不再调用工具");
  check(result.toolCalls.length === 24, "汇报请求之后不再执行任何工具");

  const recovered = await run(
    scriptedClient({
      main: r => {
        if (r <= 12) {
          const [name, args] = cycle[(r - 1) % cycle.length];
          return toolCall("r" + r, name, args);
        }
        return r <= 24 ? toolCall("r" + r, "grep_code", { q: "new-" + r }) : done("## 结论\n换路后完成");
      },
    })
  );
  check(recovered.stopReason === "final", "提醒之后换了路线（新调用）就不会被停下");
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
}

console.log("压缩：交接摘要的输入和压缩后的上下文");
{
  const checkpoints = [];
  const factA = "## 已确认事实\n- FACT-A | 证据:big_read | 置信:高\n## 当前阶段 + 下一步\n- 下一步：big_read n=6";
  const client = scriptedClient({
    main: r => (r <= 11 ? toolCall("g" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成")),
    handoff: n =>
      n === 1
        ? { content: factA, finishReason: "stop" }
        : {
            content: "## 已确认事实\n- FACT-B | 证据:big_read\n## 已否决假设\n- DEAD-B 走 wasm → 导出表里没有\n- " + "细节".repeat(300),
            finishReason: "length",
          },
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
    onCheckpoint: async summary => checkpoints.push(summary),
  });
  check(result.stopReason === "final" && client.log.handoff.length === 2, "两次压缩后正常收尾");

  const first = client.log.handoff[0];
  check(first.includes("MARK-5") && first.includes("STEP-1"), "第一次交接的输入里有最新一步（MARK-5），也有开头");
  check(
    first.includes("【用户的消息（原话") && first.includes("1. ORIGINAL-TASK") && first.includes("2. 补充：只用纯算") && first.includes("3. 继续"),
    "交接输入里按先后列出用户的原话，最后一条是当前任务"
  );
  check(first.includes("【本轮之前的对话（节选）】") && first.includes("EARLIER-CONCLUSION"), "交接输入里有锚点之前的对话（前几轮的结论）");

  const afterFirst = client.log.main[5];
  check(afterFirst.length === 4 && afterFirst[1].content.startsWith("继续"), "压缩后的上下文还是 system + 任务 + 存档 + 续跑说明，任务是「继续」");
  check(afterFirst[2].role === "assistant" && afterFirst[2].content === factA, "存档是交接账本");
  const note = String(afterFirst[3].content);
  check(note.startsWith(NOTE_START), "续跑说明的正文不变");
  check(
    note.includes("【用户此前的消息") && note.includes("1. ORIGINAL-TASK：找出 x-sign 的生成函数，不要改页面") && note.includes("2. 补充：只用纯算，别补环境"),
    "续跑说明后面附上用户此前的消息原文"
  );
  check(!note.includes("继续\n") && !note.includes("3. "), "当前这条任务不重复列进去");

  const second = client.log.handoff[1];
  check(second.includes("【上一份进展存档】") && second.includes("FACT-A"), "第二次交接带上了上一份存档");
  check(second.includes("MARK-10") && second.includes("1. ORIGINAL-TASK"), "第二次交接有最新一步，也还有用户的原话");
  check(!second.includes("MARK-5") && !second.includes("【本轮之前的对话"), "第二次交接只总结上次压缩之后的执行记录");

  const partial = checkpoints[1];
  check(
    partial.includes("FACT-B") && partial.includes("## 交接账本超出长度被截断，以下是补充") && partial.includes("【进展存档·自动压缩】"),
    "交接账本被截断时保留已写出的部分，再补机械记录"
  );
  check(partial.includes("FACT-A") && !partial.includes("下一步：big_read n=6"), "补充里带上一份存档的结论，去掉当时的「下一步」");
  const items = await ledgerItems(partial);
  check(
    items.some(i => i.kind === "fact" && i.text.includes("FACT-B")) && items.some(i => i.kind === "deadend" && i.text.includes("DEAD-B")),
    "账本自动沉淀认得出被截断账本里的事实和已否决项"
  );
  check(items.every(i => !i.text.includes("STEP-")), "补充部分的叙述不会被算进被截断的那一节");
  const afterSecond = client.log.main[10];
  check(String(afterSecond[3].content).includes("1. ORIGINAL-TASK"), "第二次压缩后续跑说明里仍有用户此前的消息");
  check(runState.epoch === 2 && runState.lastCheckpoint === partial, "状态里记着压缩次数和最近一份存档");
}

console.log("交接摘要没生成出来：机械存档不丢之前的内容");
{
  const checkpoints = [];
  const runState = createRunState();
  runState.lastCheckpoint =
    "## 已确认事实\n- OLD-FACT 签名函数在 sign.js 第 120 行\n## 已否决假设\n- OLD-DEAD 走 wasm 的路不通 → 导出表里没有\n" +
    "## 当前阶段 + 下一步\n- 下一步：STALE-NEXT 读 sign.js 第 1 段";
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
    onCheckpoint: async summary => checkpoints.push(summary),
  });
  check(result.stopReason === "final" && checkpoints.length === 2, "压缩两次后收尾，两次交接摘要都没生成出来");
  const summary = checkpoints[0];
  check(summary.includes("OLD-FACT") && summary.includes("OLD-DEAD") && summary.includes("big_read×5"), "机械存档里有上一份存档的结论和这一段的工具记录");
  check(!summary.includes("STALE-NEXT"), "上一份存档里过时的「下一步」不带进新存档");
  check(summary.includes("## 此前对话的结尾（节选）") && summary.includes("USER-MSG-8"), "带上锚点之前对话的结尾");
  check(summary.includes("NARRATION-BULLET-5"), "机械记录里有最近的叙述");
  const items = await ledgerItems(summary);
  check(
    items.length === 2 && items[0].kind === "fact" && items[0].text.includes("OLD-FACT") && items[1].kind === "deadend" && items[1].text.includes("OLD-DEAD"),
    "账本自动沉淀只认上一份存档里的事实和已否决项，不把叙述里的条目当成已否决"
  );
  const again = checkpoints[1];
  check(
    again.includes("OLD-FACT") && again.includes("OLD-DEAD") && again.includes("NARRATION-BULLET-10") && !again.includes("STALE-NEXT"),
    "连续第二次机械存档里，最早那份存档的结论还在"
  );
  const againItems = await ledgerItems(again);
  check(
    againItems.some(i => i.kind === "fact" && i.text.includes("OLD-FACT")) && againItems.every(i => !i.text.includes("NARRATION-BULLET")),
    "嵌套带上的存档照样只沉淀事实和已否决项"
  );
  const note = String(client.log.main[5][3].content);
  check(
    note.includes("1. USER-MSG-1 ") && note.includes("…（中间 4 条略）…") && note.includes("6. USER-MSG-6 ") && note.includes("8. USER-MSG-8 ") && !note.includes("USER-MSG-3 "),
    "用户此前的消息太多时留第一条和最新的几条，中间标出略了几条"
  );
}

console.log("机械存档带上的旧存档被截开时不串节");
{
  const checkpoints = [];
  const runState = createRunState();
  const deadEnds = Array.from({ length: 30 }, (_, i) => `- DEAD-${i + 1} 试过方案 ${i + 1} → 走不通：` + "返回值对不上".repeat(30)).join("\n");
  const files = Array.from({ length: 20 }, (_, i) => `- FILE-${i + 1} out/part-${i + 1}.js — ` + "已读完".repeat(40)).join("\n");
  runState.lastCheckpoint = `## 已否决假设\n${deadEnds}\n## 工作目录文件\n${files}`;
  await run(
    scriptedClient({
      main: r => (r <= 6 ? toolCall("k" + r, "big_read", { n: r }, longStep(r)) : done("## 结论\n完成")),
      handoff: () => ({ content: "", finishReason: "stop" }),
    }),
    { runState, onCheckpoint: async summary => checkpoints.push(summary) }
  );
  const summary = checkpoints[0];
  check(summary.includes("DEAD-1 ") && summary.includes("FILE-20 ") && summary.includes("## …（中间省略约"), "旧存档超长被截开：留头尾，省略标记是一个标题");
  const items = await ledgerItems(summary);
  check(items.some(i => i.kind === "deadend" && i.text.includes("DEAD-1 ")), "截断前的已否决项照常沉淀");
  check(items.every(i => !i.text.includes("FILE-")), "截断后的文件清单不会被记成已否决");
}

console.log("自动续跑的回合：任务锚点还是用户发的任务");
{
  const step = n => `STEP-${n} ` + "分析".repeat(2000);
  const runState = createRunState();
  const options = { runState, dynamicContext: "ctx=1" };
  const first = await run(scriptedClient({ main: r => toolCall("a" + r, "big_read", { n: r }, step(r)) }), {
    ...options,
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
  const second = await run(client, { ...options, messages: resumed });
  check(second.stopReason === "final" && client.log.handoff.length === 1, "第二回合压缩一次后收尾");
  const firstRequest = client.log.main[0];
  check(
    firstRequest[1].content.startsWith("REAL-TASK") && firstRequest[1].content.includes("ctx=1") && firstRequest.at(-1).content === auto,
    "动态上下文挂在用户的任务上，不挂在引擎加的续跑提示上"
  );
  const source = client.log.handoff[0];
  check(source.includes("MARK-1") && source.includes("MARK-6") && source.includes("（系统·自动续跑）"), "压缩时上一回合的工作在执行记录里，一起总结");
  check(source.includes("1. REAL-TASK：分析 sign 参数") && !source.includes("【本轮之前的对话"), "当前任务是用户的任务");
  const afterCompaction = client.log.main[3];
  check(
    afterCompaction.length === 4 && afterCompaction[1].content.startsWith("REAL-TASK") && afterCompaction[2].content.includes("FACT-RESUME"),
    "压缩后的上下文是 system + 用户的任务 + 存档 + 续跑说明"
  );
  check(userTexts(afterCompaction).every(t => !t.includes("自动续跑")), "续跑提示已经总结进存档，不再留在上下文里");

  const detached = scriptedClient({ main: () => done("## 结论\nok") });
  await run(detached, { dynamicContext: "ctx=1", messages: resumed });
  check(detached.log.main[0].at(-1).content.includes("ctx=1"), "不共用状态时退回取最后一条 user 消息（行为和以前一致）");
}

console.log("AgentSession：一次执行共用一份状态");
{
  const created = [];
  const seen = [];
  const replies = [];
  const conversationStore = {
    consumeCancellationBoundary: async () => false,
    setThreadTurnStatus: async () => {},
    getThread: async () => null,
    appendMessage: async () => {},
  };
  const store = { getGlobalSystemPrompt: () => "", getContextStrategy: () => "projected" };
  const imports = {
    "./AgentLoop.sys.mjs": {
      createRunState() {
        const state = { calls: new Map(), id: created.length + 1 };
        created.push(state);
        return state;
      },
      async runAgentTurn(options) {
        seen.push(options.runState);
        return replies.shift() || { content: "done", stopReason: "final", messages: [] };
      },
    },
    "./ConfigStore.sys.mjs": { configStore: store },
    "./ConversationStore.sys.mjs": { conversationStore },
    "./ToolRouter.sys.mjs": { ToolRouter: class { registerAll() {} } },
    "./Tools.sys.mjs": { createBuiltinTools: () => [] },
    "./Backends.sys.mjs": { getBackends: () => ({}) },
    "./providers.sys.mjs": { buildClientFromStore: () => ({}), isVisionModel: () => false },
    "./ContextProjection.sys.mjs": {},
    "./Usage.sys.mjs": { emptyUsage, mergeUsage, normalizeUsage },
  };
  const source = await readFile(new URL("../modules/AgentSession.sys.mjs", import.meta.url), "utf8");
  const { code } = transformSync(source, { format: "cjs", target: "es2022" });
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
    Services: { obs: { addObserver() {} } },
    AbortController,
    console,
  });
  const session = module.exports.agentSession;
  const runOnce = () => session.run("loop-thread", { systemPrompt: "sys", convo: [{ role: "user", content: "task" }] });

  replies.push({ content: "到上限", stopReason: "max_rounds", messages: [] }, { content: "完成", stopReason: "final", messages: [] });
  await runOnce();
  check(seen.length === 2 && seen[0] === seen[1] && seen[0].id === 1, "自动续跑的两个回合拿到同一份状态");
  await runOnce();
  check(seen.length === 3 && seen[2].id === 2, "用户再发起一次执行时换一份新的");
  replies.push({ content: "检测到循环", stopReason: "loop", messages: [] });
  await runOnce();
  check(seen.length === 4 && session.getState("loop-thread").content === "检测到循环", "stopReason=loop 不自动续跑，结果照常落盘");
}

console.log(`\nLoop guard selftest: ${pass} passed`);
