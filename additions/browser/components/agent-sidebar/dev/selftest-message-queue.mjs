import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { ConversationStore } from "../modules/ConversationStore.sys.mjs";
import { WorkspaceBackend } from "../modules/WorkspaceBackend.sys.mjs";
import { loadAgentSession } from "./agent-session-harness.mjs";

const store = new ConversationStore({ memoryOnly: true });
const config = new ConfigStore();
config.setContextStrategy("legacy");
const withImages = config.createModelProfile({ name: "看图", model: "A", imageInput: "on" });
const textOnly = config.createModelProfile({ name: "文字", model: "B", imageInput: "off" }, { activate: false });
const requests = [];
const messages = id => store.getThread(id).then(t => t.messages.map(m => m.content));
const user = (content, images) => ({ role: "user", content, ...(images && { images }) });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const stalledTurns = new Set();
let stallMode = "text";
const session = await loadAgentSession({
  configStore: config,
  conversationStore: Object.fromEntries(
    [
      "getThread",
      "appendMessage",
      "setThreadTurnStatus",
      "consumeCancellationBoundary",
      "materializeImages",
      "setExternalImageRefs",
    ].map(name => [name, store[name].bind(store)])
  ),
  providers: {
    resolveImageInput: setting => ({ supported: setting === "on" }),
    buildClientFromStore(settings, { sessionId }) {
      const model = settings.getActiveModelProfile().model;
      return { sessionId, model };
    },
  },
  agentLoop: {
    createRunState: () => ({}),
    async runAgentTurn({ client, router, messages: history, systemPrompt, dynamicContext, toolCtx, signal, onDelta, onReasoning, onEvent }) {
      assert.ok(router, "排队和引导回合均保留完整 Agent 工具路由");
      const lastContent = history.at(-1)?.content;
      if (stalledTurns.has(lastContent)) {
        stalledTurns.delete(lastContent);
        if (stallMode === "think") {
          onReasoning("正在推理但尚未输出正文");
        } else if (stallMode === "tool") {
          onEvent({ type: "tool_call", id: "c1", name: "page_eval", args: { code: "1+1" } });
          onEvent({ type: "tool_result", id: "c1", name: "page_eval", env: { ok: true, data: 2 }, ms: 5 });
        } else {
          onDelta("已写出的内容");
        }
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("interrupted");
      }
      requests.push({
        sessionId: client.sessionId,
        history,
        model: client.model,
        systemPrompt,
        dynamicContext,
        workspaceRoot: toolCtx?.workspaceRoot ?? null,
      });
      onDelta("收到");
      return { content: "收到", stopReason: "final" };
    },
  },
});

async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "会话应在时限内更新");
    await sleep(5);
  }
}
const pending = id => Array.from(session.getState(id).pendingMessages);
async function start(content, opts = {}) {
  const { id } = await store.createThread("测试会话", opts.workspace ?? null, opts.mode ?? "assist");
  await store.appendMessage(id, user(content));
  stalledTurns.add(content);
  stallMode = opts.stallMode || "text";
  void session.run(id, {
    systemPrompt: "基础提示::assist",
    baseSystemPrompt: "基础提示",
    modePrompts: { auto: "::auto", assist: "::assist" },
    workspaceRoot: opts.workspace ?? null,
    assist: (opts.mode ?? "assist") === "assist",
  });
  await until(() => session.getState(id).steps.length > 0);
  return id;
}

const id = await start("原来的问题", { workspace: "/work/a" });
for (const text of ["第一条", "优先这条", "撤回", "最后一条"]) session.queueMessage(id, user(text));
const [, steer, remove] = pending(id);
session.removeQueuedMessage(id, remove.id);
assert.deepEqual(await messages(id), ["原来的问题"]);
assert.equal(requests.length, 0);
config.setActiveModelProfileId(textOnly.id);
session.steerQueuedMessage(id, steer.id);
session.steerQueuedMessage(id, steer.id);
assert.equal(pending(id)[0]?.steering, true, "引导收尾期间待发项保留在可见列表并标记引导中");
await until(() => !session.isRunning(id));
assert.deepEqual(requests.map(r => r.history.at(-1).content), ["优先这条", "第一条", "最后一条"]);
assert.ok(requests.every(r => r.model === "B"));
assert.ok(requests.every(r => r.systemPrompt === "基础提示::assist"), "排队与引导回合保持稳定 systemPrompt 前缀");
assert.ok(requests.every(r => r.workspaceRoot === "/work/a"), "排队与引导回合沿用会话绑定的工作目录");
assert.match(requests[0].dynamicContext, /用户引导补充/, "引导回合通过动态上下文注入转向说明");
assert.deepEqual(await messages(id), ["原来的问题", "已写出的内容", "优先这条", "收到", "第一条", "收到", "最后一条", "收到"]);
assert.equal((await store.getThread(id)).cancellationPending, false);

// 仅思考尚未产出正文时点引导：不落盘空字符串 assistant 消息（避免 Anthropic/Gemini 拒绝空文本块）。
const thinkId = await start("思考中问题", { stallMode: "think" });
session.queueMessage(thinkId, user("直接看结论"));
session.steerQueuedMessage(thinkId, pending(thinkId)[0].id);
await until(() => !session.isRunning(thinkId));
assert.deepEqual(await messages(thinkId), ["思考中问题", "直接看结论", "收到"]);

// 仅执行工具尚未产出正文时点引导：落盘非空工具执行摘要，保留步骤与非空文本。
const toolId = await start("工具中问题", { stallMode: "tool" });
session.queueMessage(toolId, user("换个工具"));
session.steerQueuedMessage(toolId, pending(toolId)[0].id);
await until(() => !session.isRunning(toolId));
const toolMsgs = await messages(toolId);
assert.equal(toolMsgs.length, 4);
assert.match(toolMsgs[1], /已执行工具：page_eval/);

// 模型在图片排队后切换：保留消息，且删除其它会话做图片 GC 时不误删队列中的图片。
const image = await store.saveImage(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13), { width: 1, height: 1 });
config.setActiveModelProfileId(withImages.id);
const photoId = await start("看图");
session.queueMessage(photoId, user("", [image]));
const tempThread = await store.createThread();
await store.deleteThread(tempThread.id);
assert.ok((await store.readImage(image))?.length > 0, "队列中待发的图片不会被其它会话删除触发的 GC 回收");
config.setActiveModelProfileId(textOnly.id);
const [photo] = pending(photoId);
session.steerQueuedMessage(photoId, photo.id);
await until(() => !session.isRunning(photoId));
assert.match(session.getState(photoId).error, /图片/);
assert.deepEqual(pending(photoId).map(p => [p.id, p.imageCount]), [[photo.id, 1]]);
const beforePhotoSend = requests.length;
config.setActiveModelProfileId(withImages.id);
session.steerQueuedMessage(photoId, photo.id);
await until(() => !session.isRunning(photoId));
assert.equal(requests.at(-1).history.at(-1).content[0].type, "image_url");
assert.equal(requests.length, beforePhotoSend + 1);

// 分支会话选择「暂不设置」工作目录（workspaceRoot: null）时，绝不回退到全局 this._root。
const ws = new WorkspaceBackend();
ws.setRoot("/tmp/parent-workspace");
assert.equal(ws.getRoot({ workspaceRoot: null }), null, "显式 workspaceRoot=null 与全局工作目录隔离");
assert.throws(() => ws._assertRoot({ workspaceRoot: null }), /尚未设置工作目录/);

// 卡在最后一次写盘时点引导，当前回复已经生成；同一条依然只派发一次。
const writing = deferred(), release = deferred();
const originalSave = store._save;
const raceId = (await store.createThread()).id;
store._save = async function () {
  if ((await this.getThread(raceId)).messages.at(-1)?.role === "assistant") {
    writing.resolve();
    await release.promise;
  }
  return originalSave.call(this);
};
session.queueMessage(raceId, user("刚完成"));
await writing.promise;
session.queueMessage(raceId, user("收尾补充"));
const [late] = pending(raceId);
session.steerQueuedMessage(raceId, late.id);
release.resolve();
await until(() => !session.isRunning(raceId));
session.steerQueuedMessage(raceId, late.id);
assert.deepEqual(await messages(raceId), ["刚完成", "收到", "收尾补充", "收到"]);

// 手动停止要暂停待发消息；磁盘写入失败后重试也不应重复追加。
const stopped = await start("手动停止");
session.queueMessage(stopped, user("稍后再发"));
session.stop(stopped);
await until(() => !session.isRunning(stopped));
const [paused] = pending(stopped);
store._save = async function () {
  if ((await this.getThread(stopped)).messages.at(-1)?.content === "稍后再发") throw new Error("disk full");
};
session.steerQueuedMessage(stopped, paused.id);
await until(() => !session.isRunning(stopped));
assert.equal(pending(stopped)[0].id, paused.id);
assert.ok(!(await messages(stopped)).includes("稍后再发"));
store._save = originalSave;
session.steerQueuedMessage(stopped, paused.id);
await until(() => !session.isRunning(stopped));
assert.equal((await messages(stopped)).filter(text => text === "稍后再发").length, 1);
assert.deepEqual(pending(stopped), []);
console.log("Message queue: Agent tools, steering, non-empty interrupted steps, workspace isolation, image GC, late click, stop and retry passed");
