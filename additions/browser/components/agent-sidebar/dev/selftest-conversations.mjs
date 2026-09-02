/* dev/selftest-conversations.mjs — ConversationStore（内存 backend）逻辑自测。
 *   node dev/selftest-conversations.mjs
 */
import { ConversationStore } from "../modules/ConversationStore.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.error("  ✗ FAIL:", m)));

const s = new ConversationStore({ memoryOnly: true });

ok((await s.listThreads()).length === 0, "初始无线程");

const t1 = await s.createThread();
ok(t1.id && t1.title === "新对话" && t1.messages.length === 0, "createThread 返回空线程");
ok((await s.listThreads()).length === 1, "列表含 1 条");

await s.appendMessage(t1.id, { role: "user", content: "帮我分析 sign 加密入口在哪" });
const got = await s.getThread(t1.id);
ok(got.messages.length === 1 && got.messages[0].role === "user", "appendMessage 落入");
ok(got.title === "帮我分析 sign 加密入口在哪", "首条 user 消息自动成标题");

await s.appendMessage(t1.id, { role: "assistant", content: "..." });
ok((await s.getThread(t1.id)).messages.length === 2, "assistant 消息追加");

const longThread = await s.createThread("长会话");
for (let i = 0; i < 10; i++) {
  await s.appendMessage(longThread.id, {
    role: i % 2 ? "assistant" : "user",
    content: `${i}:` + "x".repeat(2000),
  });
}
await s.setContextProjection(longThread.id, {
  version: 1,
  summary: "已确认事实和下一步",
  cutoff: 6,
  sourceCount: 6,
  createdAt: 1,
  updatedAt: 2,
  strategy: "projected",
});
const projected = await s.getModelMessages(longThread.id, { strategy: "projected" });
ok(projected.length < 10 && projected[2].role === "user", "模型历史使用持久化投影并从安全边界续接");
ok((await s.getThread(longThread.id)).messages.length === 10, "投影不删除 UI 完整历史");
await s.addThreadUsage(longThread.id, {
  requests: 2,
  inputTokens: 1000,
  uncachedInputTokens: 400,
  outputTokens: 50,
  cacheReadTokens: 600,
  providerReported: true,
});
ok((await s.getThread(longThread.id)).usage.cacheReadTokens === 600, "会话累计 Usage 持久化");

const beforeFailedSave = (await s.getThread(longThread.id)).contextProjection.summary;
const originalSave = s._save.bind(s);
s._save = async () => { throw new Error("simulated disk failure"); };
let projectionSaveFailed = false;
try {
  await s.setContextProjection(longThread.id, {
    version: 1,
    summary: "must not leak into memory",
    cutoff: 6,
    sourceCount: 6,
    createdAt: 1,
    updatedAt: 3,
  });
} catch {
  projectionSaveFailed = true;
}
s._save = originalSave;
ok(projectionSaveFailed && (await s.getThread(longThread.id)).contextProjection.summary === beforeFailedSave, "投影写盘失败回滚到旧版本");

await s.setThreadTurnStatus(t1.id, "cancelled");
ok((await s.getThread(t1.id)).cancellationPending === true, "手动停止写入取消边界");
ok((await s.consumeCancellationBoundary(t1.id)) === true, "下一轮消费取消边界");
ok((await s.consumeCancellationBoundary(t1.id)) === false, "取消边界只消费一次");

const bundle = await s.exportThread(t1.id);
ok(bundle.format === "firefox-reverse-conversation" && bundle.schemaVersion === 1, "导出包格式带版本");
ok(!("workspace" in bundle.conversation) && !("envId" in bundle.conversation), "导出不携带本机目录和环境绑定");
const imported = await s.importThread(JSON.stringify(bundle));
ok(imported.id !== t1.id && imported.messages.length === 2, "导入生成新 id 并保留消息");
ok(imported.workspace === null && imported.envId === null && imported.lastTurnStatus === "idle", "导入会话保持静止且不绑定本机资源");
ok(imported.contextProjection === null && imported.usage.requests === 0, "导入不携带运行期投影和 Usage");
let badImport = false;
try { await s.importThread('{"hello":true}'); } catch { badImport = true; }
ok(badImport, "拒绝非 Firefox Reverse 会话 JSON");

// 第二个线程 + 排序（updatedAt 倒序）
const t2 = await s.createThread();
await s.appendMessage(t2.id, { role: "user", content: "第二个对话" });
const list = await s.listThreads();
ok(list[0].id === t2.id, "最近更新的线程排在前");
ok(list.find(t => t.id === t1.id).count === 2, "摘要带消息计数");

await s.renameThread(t1.id, "RC4 入口分析");
ok((await s.getThread(t1.id)).title === "RC4 入口分析", "renameThread 生效");

await s.deleteThread(t2.id);
ok((await s.listThreads()).length === 3, "deleteThread 仅删除目标线程，导入和长会话仍保留");

console.log(`\nConversationStore 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
