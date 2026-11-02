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

// 全部会话打包导出、导入（#7）：空会话不导出；单会话包和全部会话包都能导入；导入过的不重复导入。
{
  const office = new ConversationStore({ memoryOnly: true });
  const a = await office.createThread();
  await office.appendMessage(a.id, { role: "user", content: "分析签名 a" });
  await office.appendMessage(a.id, { role: "assistant", content: "入口在 sign()" });
  await office.renameThread(a.id, "签名分析");
  const empty = await office.createThread();
  const b = await office.createThread();
  await office.appendMessage(b.id, { role: "user", content: "抓包 b" });
  await office.setThreadMode?.(b.id, "assist");
  const { bundle: all, skipped } = await office.exportAllThreads();
  ok(all.format === "firefox-reverse-conversations" && all.schemaVersion === 1, "全部会话包带格式和版本");
  ok(all.conversations.length === 2 && skipped.length === 1 && skipped[0].reason === "empty", "空会话不导出，并记在 skipped 里");
  ok(all.conversations[0].sourceThreadId === b.id && all.conversations[1].sourceThreadId === a.id, "包里按最近更新排序");
  ok(all.conversations.every(c => !("workspace" in c) && !("envId" in c) && !("usage" in c)), "包里不带本机目录、环境绑定和 Usage");
  ok(!all.conversations.some(c => c.sourceThreadId === empty.id), "空会话不在包里");

  const home = new ConversationStore({ memoryOnly: true });
  const first = await home.importConversations(JSON.stringify(all));
  ok(first.imported.length === 2 && first.duplicates.length === 0, "全部会话包一次导入两个会话");
  const homeList = await home.listThreads();
  ok(homeList[0].title === all.conversations[0].title && homeList[1].title === "签名分析", "导入后保持原来的先后顺序");
  const importedA = first.imported.find(t => t.title === "签名分析");
  ok(importedA.messages.length === 2 && importedA.workspace === null && importedA.envId === null && importedA.lastTurnStatus === "idle", "导入的会话保留消息，不绑定本机资源，保持静止");
  ok(importedA.importedFrom.sourceThreadId === a.id && Number.isFinite(importedA.importedFrom.sourceUpdatedAt), "记下来源会话和它导出时的更新时间");

  const again = await home.importConversations(JSON.stringify(all));
  ok(again.imported.length === 0 && again.duplicates.length === 2 && (await home.listThreads()).length === 2, "同一个包再导一次不重复导入");
  await home.appendMessage(importedA.id, { role: "user", content: "回家接着聊" });
  const afterChat = await home.importConversations(JSON.stringify(all));
  ok(afterChat.imported.length === 0 && afterChat.duplicates.length === 2, "导入后在本机接着聊过，再导同一个包也认得出来");

  const sameProfile = await office.importConversations(JSON.stringify(all));
  ok(sameProfile.imported.length === 0 && sameProfile.duplicates.length === 2, "导回原来的 profile：原会话没改过就不重复导入");
  await office.appendMessage(a.id, { role: "user", content: "办公室又聊了一句" });
  const updated = await office.exportAllThreads();
  const third = await home.importConversations(JSON.stringify(updated.bundle));
  ok(third.imported.length === 1 && third.imported[0].messages.length === 3 && third.duplicates.length === 1, "来源里更新过的作为新会话导入，没改过的跳过");

  const single = await office.exportThread(b.id);
  const singleIntoHome = await home.importConversations(JSON.stringify(single));
  ok(singleIntoHome.imported.length === 0 && singleIntoHome.duplicates.length === 1, "单会话包也走同样的去重");
  const fresh = new ConversationStore({ memoryOnly: true });
  const singleIntoFresh = await fresh.importConversations(JSON.stringify(single));
  ok(singleIntoFresh.imported.length === 1 && singleIntoFresh.imported[0].mode === "assist", "单会话包导入一个会话");

  const broken = JSON.parse(JSON.stringify(all));
  broken.conversations[1].messages[0].role = "system";
  const before = (await fresh.listThreads()).length;
  let brokenError = "";
  try { await fresh.importConversations(JSON.stringify(broken)); } catch (e) { brokenError = e.message; }
  ok(/第 2 个会话：第 1 条消息角色无效/.test(brokenError), "包里有一条不合格时报出是第几个会话");
  ok((await fresh.listThreads()).length === before, "有不合格的条目时整个包都不导入");

  let notArray = "";
  try { await fresh.importConversations(JSON.stringify({ ...all, conversations: {} })); } catch (e) { notArray = e.message; }
  ok(/缺少 conversations/.test(notArray), "conversations 不是数组时拒绝");
  let tooMany = "";
  try { await fresh.importConversations({ ...all, conversations: new Array(5001).fill(all.conversations[0]) }); } catch (e) { tooMany = e.message; }
  ok(/会话数超过 5000/.test(tooMany), "会话数超过上限时拒绝");
  let foreign = "";
  try { await fresh.importConversations('{"format":"something-else","conversations":[]}'); } catch (e) { foreign = e.message; }
  ok(/不是受支持的 Firefox Reverse 会话文件/.test(foreign), "别的 JSON 拒绝");

  const failing = new ConversationStore({ memoryOnly: true });
  failing._save = async () => { throw new Error("disk full"); };
  let saveError = "";
  try { await failing.importConversations(JSON.stringify(all)); } catch (e) { saveError = e.message; }
  ok(saveError === "disk full" && (await failing.listThreads()).length === 0, "写盘失败时内存里也撤掉，不留半截");

  const nothing = new ConversationStore({ memoryOnly: true });
  await nothing.createThread();
  const none = await nothing.exportAllThreads();
  ok(none.bundle.conversations.length === 0 && none.skipped.length === 1, "全是空会话时包里没有会话");
}

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
