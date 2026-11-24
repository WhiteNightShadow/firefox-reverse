import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { ConversationStore } from "../modules/ConversationStore.sys.mjs";
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
const session = await loadAgentSession({
  configStore: config,
  conversationStore: Object.fromEntries(
    ["getThread", "appendMessage", "setThreadTurnStatus", "consumeCancellationBoundary", "materializeImages"]
      .map(name => [name, store[name].bind(store)])
  ),
  providers: {
    resolveImageInput: setting => ({ supported: setting === "on" }),
    buildClientFromStore(settings, { sessionId }) {
      const model = settings.getActiveModelProfile().model;
      return { model, async chat(history, options) {
        assert.equal(options.tools, undefined);
        requests.push({ sessionId, history, model });
        options.onDelta("收到");
        return { content: "收到" };
      } };
    },
  },
  agentLoop: {
    createRunState: () => ({}),
    async runAgentTurn({ signal, onDelta }) {
      onDelta("已写出的内容");
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("interrupted");
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
async function start(content) {
  const { id } = await store.createThread();
  await store.appendMessage(id, user(content));
  void session.run(id, { systemPrompt: "测试", assist: true });
  await until(() => session.getState(id).steps.length > 0);
  return id;
}

const id = await start("原来的问题");
for (const text of ["第一条", "优先这条", "撤回", "最后一条"]) session.queueMessage(id, user(text));
const [, steer, remove] = pending(id);
session.removeQueuedMessage(id, remove.id);
assert.deepEqual(await messages(id), ["原来的问题"]);
assert.equal(requests.length, 0);
config.setActiveModelProfileId(textOnly.id);
session.steerQueuedMessage(id, steer.id);
session.steerQueuedMessage(id, steer.id);
await until(() => !session.isRunning(id));
assert.deepEqual(requests.map(r => r.history.at(-1).content), ["优先这条", "第一条", "最后一条"]);
assert.ok(requests.every(r => r.model === "B"));
assert.deepEqual(await messages(id), ["原来的问题", "已写出的内容", "优先这条", "收到", "第一条", "收到", "最后一条", "收到"]);
assert.equal((await store.getThread(id)).cancellationPending, false);

// 模型在图片排队后切换：保留消息，换回支持看图的配置后只发送一次。
const image = await store.saveImage(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13), { width: 1, height: 1 });
config.setActiveModelProfileId(withImages.id);
const photoId = await start("看图");
session.queueMessage(photoId, user("", [image]));
config.setActiveModelProfileId(textOnly.id);
const [photo] = pending(photoId);
session.steerQueuedMessage(photoId, photo.id);
await until(() => !session.isRunning(photoId));
assert.match(session.getState(photoId).error, /图片/);
assert.deepEqual(pending(photoId).map(p => [p.id, p.imageCount]), [[photo.id, 1]]);
assert.equal(requests.length, 3);
config.setActiveModelProfileId(withImages.id);
session.steerQueuedMessage(photoId, photo.id);
await until(() => !session.isRunning(photoId));
assert.equal(requests.at(-1).history.at(-1).content[0].type, "image_url");
assert.equal(requests.length, 4);

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
console.log("Message queue: FIFO, steering, image model switch, late click, stop and retry passed");
