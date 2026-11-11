/* dev/selftest-images.mjs — 输入框粘贴图片（#44）：模型能不能看图的判断、图片存取与导出导入、
 * 发给模型时的图片内容块和预算、上下文估算、四种协议的请求形态、AgentSession 接线。不启动浏览器、不调用真实模型。
 *
 *   node dev/selftest-images.mjs
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  IMAGE_CONTEXT_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_REQUEST_IMAGES,
  base64ToBytes,
  bytesToBase64,
  cleanImageRefs,
  contentChars,
  limitImageParts,
  sniffImageMime,
} from "../modules/ChatImages.sys.mjs";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { ConversationStore } from "../modules/ConversationStore.sys.mjs";
import { buildProjectionInput, messageSize } from "../modules/ContextProjection.sys.mjs";
import { LlmClient } from "../modules/LlmClient.sys.mjs";
import { runAgentTurn, createRunState } from "../modules/AgentLoop.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { imageInputSupport, isVisionModel, resolveImageInput } from "../modules/providers.sys.mjs";
import { loadAgentSession } from "./agent-session-harness.mjs";

let passed = 0;
const ok = (cond, name) => {
  assert.ok(cond, name);
  passed++;
  console.log("  ✓", name);
};

// 假图片：文件头是真的 PNG/JPEG，后面随机填充（存取只认文件头，不解码）。
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const png = (size, seed = 1) => {
  const b = new Uint8Array(size);
  b.set(randomBytes(size));
  b.set(PNG_HEAD, 0);
  b[size - 1] = seed;
  return b;
};
const jpeg = size => {
  const b = new Uint8Array(randomBytes(size));
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
};
const dataUrl = (chars, mime = "image/png") => `data:${mime};base64,` + "A".repeat(chars);
const imagePart = chars => ({ type: "image_url", image_url: { url: dataUrl(chars) } });

console.log("[1] 模型能不能看图（按模型名）");
const table = [
  ["claude-opus-4-7", true], ["claude-sonnet-4-20250514", true], ["anthropic/claude-sonnet-4.5", true],
  ["us.anthropic.claude-3-7-sonnet-20250219-v1:0", true], ["claude-2.1", false], ["claude-instant-1.2", false],
  ["gpt-4o", true], ["gpt-4o-mini", true], ["gpt-4.1-mini", true], ["gpt-5.2", true], ["gpt-5-codex", true],
  ["gpt-4-turbo", true], ["gpt-4", false], ["gpt-3.5-turbo", false], ["gpt-oss-120b", false],
  ["o1", true], ["o1-preview", false], ["o1-mini", false], ["o3", true], ["o3-mini", false], ["o4-mini", true],
  ["gemini-2.5-pro", true], ["models/gemini-3-pro-preview", true], ["gemini-pro", false], ["gemma-3-27b-it", true],
  ["deepseek-v4-flash", false], ["deepseek-v4-pro", false], ["deepseek-chat", false], ["deepseek-reasoner", false],
  ["deepseek-v4-flash-vision-exp", true], ["deepseek-vl2", true],
  ["glm-5.1", false], ["glm-5", false], ["glm-4.6", false], ["glm-4.5-air", false], ["glm-4.5v", true],
  ["glm-4v-plus", true], ["glm-5v-turbo", true], ["glm-4.1v-thinking-flash", true], ["glm-4-voice", false],
  ["kimi-k2.6", true], ["kimi-k2.5", true], ["kimi-latest", true], ["kimi-k2-0711-preview", false],
  ["kimi-k2-turbo-preview", false], ["kimi-k2-thinking", false], ["moonshot-v1-128k", false],
  ["moonshot-v1-8k-vision-preview", true],
  ["MiniMax-M2.7", false], ["MiniMax-M2", false], ["minimax-vl-01", true], ["MiniMax-M3", null],
  ["qwen3-max", false], ["qwen-max-latest", false], ["qwen-plus", false], ["qwen-turbo", false],
  ["qwen3-coder-plus", false], ["qwen3-235b-a22b", false], ["qwen3.5-flash", true], ["qwen3.6-plus", true],
  ["qwen-vl-max", true], ["qwen3-vl-plus", true], ["qwen2.5-vl-72b-instruct", true], ["qvq-max", true],
  ["qwen-omni-turbo", true], ["grok-4", true], ["grok-3", false], ["grok-2-vision-1212", true],
  ["meta-llama/llama-4-scout", true], ["doubao-seed-1.6", true], ["my-gateway-model", null], ["", null],
  ["opus-4-7[1m]", null], ["claude-opus-4-7[1m]", true],
];
const wrong = table.filter(([model, want]) => imageInputSupport(model) !== want);
ok(!wrong.length, `模型名判断 ${table.length} 条全部符合预期${wrong.length ? "：" + JSON.stringify(wrong.map(([m, w]) => [m, w, imageInputSupport(m)])) : ""}`);
ok(isVisionModel("claude-opus-4-7") && !isVisionModel("MiniMax-M3") && !isVisionModel("deepseek-v4-flash"), "isVisionModel 只认确定能看图的");
ok(resolveImageInput("auto", "deepseek-v4-flash").supported === false && resolveImageInput("auto", "x").supported === null, "auto 按模型名");
ok(resolveImageInput("on", "deepseek-v4-flash").supported === true && resolveImageInput("on", "deepseek-v4-flash").auto === false, "on 覆盖模型名判断，auto 字段仍给出判断结果");
ok(resolveImageInput("off", "gpt-4o").supported === false && resolveImageInput("bogus", "gpt-4o").setting === "auto", "off 覆盖；不认识的设置按 auto");

console.log("[2] 模型配置里的「图片输入」");
const cfg = new ConfigStore();
const p0 = cfg.getActiveModelProfile();
ok(p0.imageInput === "auto" && cfg.getImageInput() === "auto", "默认 auto（旧配置没有这个字段也按 auto）");
cfg.updateModelProfile(p0.id, { imageInput: "on" });
ok(cfg.getImageInput() === "on" && cfg.getActiveModelProfile().imageInput === "on", "保存 on");
cfg.updateModelProfile(p0.id, { imageInput: "whatever" });
ok(cfg.getImageInput() === "auto", "不合法的值规整成 auto");
const dup = cfg.duplicateModelProfile(p0.id);
ok(dup.imageInput === "auto", "复制配置带上这个字段");

console.log("[3] 纯函数：文件头、base64、引用校验、内容估算、请求图片预算");
ok(sniffImageMime(png(64)) === "image/png" && sniffImageMime(jpeg(64)) === "image/jpeg", "认 PNG/JPEG 文件头");
const gif = new Uint8Array(16); gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webp = new Uint8Array(16); webp.set([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
ok(sniffImageMime(gif) === "image/gif" && sniffImageMime(webp) === "image/webp", "认 GIF/WebP 文件头");
ok(sniffImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")) === "" && sniffImageMime(new Uint8Array(3)) === "", "SVG、太短的认不出");
const big = png(300000);
ok(bytesToBase64(big) === Buffer.from(big).toString("base64"), "bytesToBase64 和标准 base64 一致（大于分块大小）");
ok(Buffer.from(base64ToBytes(Buffer.from(big).toString("base64"))).equals(Buffer.from(big)), "base64ToBytes 往返一致");
const id = "a".repeat(64);
const refs = cleanImageRefs([
  { id, mime: "image/png", width: 10, height: 20, size: 100 },
  { id: "x", mime: "image/png" },
  { id, mime: "image/svg+xml" },
  ...Array.from({ length: 12 }, () => ({ id, mime: "image/jpeg", width: 1.5, height: -3, size: MAX_IMAGE_BYTES + 1 })),
]);
ok(refs.length === MAX_IMAGES_PER_MESSAGE && refs[0].width === 10 && refs[1].width === 0 && refs[1].size === 0, "引用校验：丢掉坏 id 和 SVG，最多 8 张，不合法的宽高大小记 0");
ok(contentChars([{ type: "text", text: "看图" }, imagePart(2_000_000)]) === 2 + IMAGE_CONTEXT_CHARS, "上下文估算：一张 2MB 的图按估算算，不按 base64 长度");
const plain = [{ role: "user", content: [imagePart(100), { type: "text", text: "a" }] }];
ok(limitImageParts(plain) === plain, "没超预算时原样返回同一个数组");
const many = Array.from({ length: 25 }, (_, i) => ({ role: "user", content: [imagePart(1000 + i), { type: "text", text: "图" + i }] }));
many.push({ role: "assistant", content: "ok" });
const limited = limitImageParts(many);
const keptIdx = limited.map((m, i) => (Array.isArray(m.content) && m.content.some(p => p.type === "image_url") ? i : -1)).filter(i => i >= 0);
ok(keptIdx.length === MAX_REQUEST_IMAGES && keptIdx[0] === 5 && keptIdx.at(-1) === 24, "超过 20 张：留最新的 20 张");
ok(/时间较早，这次没有发给模型/.test(limited[0].content[0].text) && limited[0].content[1].text === "图0" && many[0].content[0].type === "image_url", "更早的换成文字说明，原消息不改");
const heavy = [
  { role: "user", content: [imagePart(6_000_000), imagePart(6_000_000), { type: "text", text: "x" }] },
  { role: "user", content: [imagePart(7_000_000)] },
];
const heavyOut = limitImageParts(heavy);
ok(heavyOut[1].content[0].type === "image_url" && heavyOut[0].content.filter(p => p.type === "image_url").length === 0 && /2 张图片/.test(heavyOut[0].content[0].text), "按字符数预算：放不下的整条消息的图都换成一句说明");
const toolish = [{ role: "tool", tool_call_id: "1", content: "x" }, { role: "assistant", content: [imagePart(13_000_000)] }];
ok(limitImageParts(toolish) === toolish, "只动 user 消息");

console.log("[4] ConversationStore：存图、写消息、发给模型的内容块");
const store = new ConversationStore({ memoryOnly: true });
const imgA = png(5000, 1);
const imgB = jpeg(4000);
const refA = await store.saveImage(imgA, { width: 1600, height: 900 });
const refA2 = await store.saveImage(new Uint8Array(imgA), { width: 1600, height: 900 });
ok(/^[0-9a-f]{64}$/.test(refA.id) && refA.mime === "image/png" && refA.size === 5000 && refA.width === 1600, "存图返回 sha256 引用，格式按文件头");
ok(refA2.id === refA.id && store._images.size === 1, "同一张图存两次只有一份");
const refB = await store.saveImage(imgB, { width: 800, height: 600 });
ok(refB.mime === "image/jpeg", "JPEG");
await assert.rejects(store.saveImage(new TextEncoder().encode("not an image at all")), /不是支持的图片格式/);
await assert.rejects(store.saveImage(png(MAX_IMAGE_BYTES + 1)), /超过/);
await assert.rejects(store.saveImage(new Uint8Array()), /空/);
ok(true, "不是图片、超过 3.5MB、空的都拒绝");
const t1 = await store.createThread();
await store.appendMessage(t1.id, { role: "user", content: "", images: [refA, { id: "bad" }] });
let th = await store.getThread(t1.id);
ok(th.title === "图片" && th.messages[0].images.length === 1 && th.messages[0].images[0].id === refA.id, "只有图片的消息：标题记成「图片」，坏引用丢掉");
await store.appendMessage(t1.id, { role: "assistant", content: "看到了" });
await store.appendMessage(t1.id, { role: "user", content: "这两张呢", images: [refA, refB] });
const modelMsgs = await store.getModelMessages(t1.id, { strategy: "legacy" });
ok(modelMsgs[2].images.length === 2 && modelMsgs[1].images === undefined, "getModelMessages 带上图片引用");
const mat = await store.materializeImages(modelMsgs);
ok(Array.isArray(mat[0].content) && mat[0].content.length === 1 && mat[0].content[0].image_url.url.startsWith("data:image/png;base64,"), "只有图的消息：内容只有图，不带空文字块");
ok(mat[2].content.map(p => p.type).join(",") === "image_url,image_url,text" && mat[2].content[2].text === "这两张呢", "图在前、文字在后");
ok(mat[2].content[1].image_url.url === "data:image/jpeg;base64," + Buffer.from(imgB).toString("base64"), "data URL 是图片的标准 base64");
ok(mat.every(m => !("images" in m)) && mat[1].content === "看到了", "发给模型的消息不带 images 字段，没有图的消息不变");
const off = await store.materializeImages(modelMsgs, { allowImages: false });
ok(off[2].content.startsWith("［这里附有 2 张图片，当前模型不支持看图") && off[2].content.endsWith("这两张呢") && typeof off[0].content === "string", "模型不能看图：换成文字说明，原话保留");
const budget = await store.materializeImages(modelMsgs, { maxImages: 2 });
ok(budget[2].content.filter(p => p.type === "image_url").length === 2 && typeof budget[0].content === "string" && /时间较早/.test(budget[0].content), "张数预算从最新的消息往前留");
const ghost = { id: "f".repeat(64), mime: "image/png", width: 1, height: 1, size: 10 };
const lost = await store.materializeImages([{ role: "user", content: "还在吗", images: [ghost, refA] }]);
ok(lost[0].content.length === 2 && /1 张图片，图片文件已经不在了/.test(lost[0].content[1].text), "图片文件不在了：换成说明，不让请求失败");

console.log("[5] 导出导入带图片、删会话清图片");
const exported = await store.exportThread(t1.id);
const exImgs = exported.conversation.messages[2].images;
ok(exImgs.length === 2 && exImgs[0].data === Buffer.from(imgA).toString("base64") && exImgs[1].mime === "image/jpeg" && exImgs[0].width === 1600, "单会话导出把图片嵌进文件");
ok(!("id" in exImgs[0]), "导出的是图片数据，不是本机引用");
const home = new ConversationStore({ memoryOnly: true });
const { imported } = await home.importConversations(JSON.stringify(exported));
const homeThread = await home.getThread(imported[0].id);
ok(homeThread.messages[2].images.length === 2 && homeThread.messages[2].images[0].id === refA.id && home._images.size === 2, "导入后图片存进新 profile，引用和原来一样");
ok(!homeThread.messages.some(m => "pendingImages" in m), "导入后不留中间字段");
const homeMat = await home.materializeImages(await home.getModelMessages(homeThread.id, { strategy: "legacy" }));
ok(homeMat[2].content[0].image_url.url === mat[2].content[0].image_url.url, "导入的图片发给模型时和原来一样");
const { bundle } = await store.exportAllThreads();
ok(bundle.conversations[0].messages[0].images[0].data === Buffer.from(imgA).toString("base64"), "全部导出也带图片");
const badBundle = JSON.parse(JSON.stringify(exported));
badBundle.conversation.messages[2].images[1].data = Buffer.from("<svg/>").toString("base64");
await assert.rejects(new ConversationStore({ memoryOnly: true }).importConversations(JSON.stringify(badBundle)), /第 3 条消息的图片第 2 张不是支持的图片/);
const nine = JSON.parse(JSON.stringify(exported));
nine.conversation.messages[2].images = Array.from({ length: 9 }, () => exImgs[0]);
await assert.rejects(new ConversationStore({ memoryOnly: true }).importConversations(JSON.stringify(nine)), /超过 8 张/);
ok(true, "坏图片、超过 8 张的导入文件整个拒绝");
const oldFile = JSON.parse(JSON.stringify(exported));
for (const m of oldFile.conversation.messages) delete m.images;
const plainHome = new ConversationStore({ memoryOnly: true });
await plainHome.importConversations(JSON.stringify(oldFile));
ok(plainHome._images.size === 0, "没有图片的旧导出文件照常导入");
const t2 = await store.createThread();
await store.appendMessage(t2.id, { role: "user", content: "只用 B", images: [refB] });
await store.deleteThread(t1.id);
ok(store._images.size === 1 && store._images.has(refB.id), "删会话后，只被它引用的图片清掉，别的会话还在用的留着");

console.log("[6] 存在磁盘上的图片：文件名、读回、清理的宽限时间");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "frx-images-"));
try {
  globalThis.PathUtils = { join: (...p) => path.join(...p), parent: p => path.dirname(p), filename: p => path.basename(p), profileDir: tmp };
  globalThis.IOUtils = {
    makeDirectory: async p => fs.mkdir(p, { recursive: true }),
    exists: async p => fs.access(p).then(() => true, () => false),
    write: async (p, data) => (await fs.writeFile(p, data), data.length),
    read: async p => new Uint8Array(await fs.readFile(p)),
    getChildren: async p => (await fs.readdir(p)).map(n => path.join(p, n)),
    stat: async p => {
      const s = await fs.stat(p);
      return { size: s.size, lastModified: s.mtimeMs };
    },
    remove: async p => fs.rm(p, { force: true }),
    setModificationTime: async (p, ms) => {
      const d = new Date(ms ?? Date.now());
      await fs.utimes(p, d, d);
    },
    readJSON: async p => JSON.parse(await fs.readFile(p, "utf8")),
    writeJSON: async (p, value) => fs.writeFile(p, JSON.stringify(value)),
  };
  const disk = new ConversationStore({ memoryOnly: false });
  const dref = await disk.saveImage(imgA, { width: 1600, height: 900 });
  const dir = path.join(tmp, "firefox-reverse-agent", "images");
  const file = path.join(dir, dref.id + ".png");
  ok((await fs.readFile(file)).equals(Buffer.from(imgA)), "图片按 <sha256>.png 存在 profile 的 firefox-reverse-agent/images 下");
  ok(Buffer.from(await disk.readImage(dref)).equals(Buffer.from(imgA)), "readImage 读回原字节");
  const conv = JSON.parse(await fs.readFile(path.join(tmp, "firefox-reverse-agent", "conversations.json"), "utf8").catch(() => "{}"));
  ok(!JSON.stringify(conv).includes(Buffer.from(imgA).toString("base64").slice(0, 40)), "图片数据不进 conversations.json");
  const td = await disk.createThread();
  await disk.appendMessage(td.id, { role: "user", content: "磁盘上的图", images: [dref] });
  ok(!(await fs.readFile(path.join(tmp, "firefox-reverse-agent", "conversations.json"), "utf8")).includes(Buffer.from(imgA).toString("base64").slice(0, 40)), "写消息后 conversations.json 里也只有引用");
  const oldBytes = png(300, 7);
  const orphanOld = await disk.saveImage(oldBytes);
  const orphanNew = await disk.saveImage(png(300, 8));
  const hourAgo = Date.now() - 2 * 60 * 60 * 1000;
  await IOUtils.setModificationTime(path.join(dir, orphanOld.id + ".png"), hourAgo);
  await fs.writeFile(path.join(dir, "notes.txt"), "keep me");
  const other = await disk.createThread();
  await disk.deleteThread(other.id);
  const left = (await fs.readdir(dir)).sort();
  ok(left.includes(dref.id + ".png") && left.includes(orphanNew.id + ".png") && !left.includes(orphanOld.id + ".png") && left.includes("notes.txt"),
    "清理只删没人用、放了超过一小时的图片文件；刚存的、在用的、别的文件不动");
  const again = await disk.saveImage(oldBytes);
  ok(again.id === orphanOld.id && (await fs.stat(path.join(dir, again.id + ".png"))).isFile(), "删掉后再存同一张图会重新写出来");
  await fs.utimes(path.join(dir, dref.id + ".png"), new Date(hourAgo), new Date(hourAgo));
  await disk.saveImage(imgA);
  ok(Date.now() - (await fs.stat(path.join(dir, dref.id + ".png"))).mtimeMs < 60000, "再存已有的图会刷新修改时间（不会在写进消息前被清掉）");
} finally {
  delete globalThis.IOUtils;
  delete globalThis.PathUtils;
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("[7] 上下文投影的估算和摘要输入");
const withRefs = { role: "user", content: "看这个", images: [refA, refB] };
ok(messageSize(withRefs) === 16 + 3 + 2 * IMAGE_CONTEXT_CHARS, "消息上的图片引用按估算计入大小");
ok(messageSize({ role: "user", content: [imagePart(3_000_000), { type: "text", text: "x" }] }) < 5000, "内容块里的图片不按 base64 长度算");
const source = buildProjectionInput([withRefs, { role: "assistant", content: "嗯" }, { role: "user", content: "下一步" }], { cutoff: 2 });
ok(source.includes("[User] 看这个（附图 2 张）") && !source.includes("base64"), "投影的摘要输入写明附了几张图，不带图片数据");

console.log("[8] AgentLoop：带图的消息不触发压缩，图片原样发出，超过 20 张时从最早的开始换成说明");
const seen = [];
// 第一次请求调一次工具（压缩检查从第 2 轮开始），之后回文字。
const client = {
  model: "gpt-4o", // 默认上下文档：250k 字符就压缩，一张图按 base64 长度算就超了
  async chat(messages, opts = {}) {
    seen.push(messages);
    if (opts.tools && !messages.some(m => m.role === "tool")) {
      return { content: "", toolCalls: [{ id: "n1", type: "function", function: { name: "noop", arguments: "{}" } }], finishReason: "tool_calls", usage: null, raw: {} };
    }
    return { content: "看到了", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
  },
};
const router = new ToolRouter();
router.register({ name: "noop", needsConfirm: false, handler: async () => ({ ok: true, note: "done" }) });
const events = [];
const bigShot = { role: "user", content: [imagePart(4_000_000), { type: "text", text: "这张截图里的签名参数是什么" }] };
const res = await runAgentTurn({ client, router, messages: [bigShot], dynamicContext: "【当前工作目录】未设置。", autoApprove: true, assist: true, maxRounds: 4, onEvent: e => events.push(e.type), runState: createRunState() });
const sent = seen[0].find(m => m.role === "user");
ok(res.stopReason === "final" && seen.length === 2 && !events.includes("checkpoint"), "一张 4MB 的图不会让上下文「超限」去压缩（第 2 轮照常回答）");
ok(sent.content[0].type === "image_url" && sent.content[0].image_url.url.length === bigShot.content[0].image_url.url.length, "图片原样发给模型");
ok(sent.content.at(-1).type === "text" && sent.content.at(-1).text.includes("【本轮动态上下文】") && sent.content[1].text === "这张截图里的签名参数是什么", "动态上下文接在图片和文字后面");
seen.length = 0;
const history = Array.from({ length: 22 }, (_, i) => ({ role: "user", content: [imagePart(1000), { type: "text", text: "第" + i + "张" }] }));
const interleaved = history.flatMap((m, i) => [m, { role: "assistant", content: "收到 " + i }]);
interleaved.push({ role: "user", content: "总结一下" });
await runAgentTurn({ client: { ...client, chat: async m => (seen.push(m), { content: "好", toolCalls: [], finishReason: "stop", usage: null, raw: {} }) }, router, messages: interleaved, autoApprove: true, assist: true, maxRounds: 2, runState: createRunState() });
const imgs = seen[0].filter(m => m.role === "user" && Array.isArray(m.content)).flatMap(m => m.content).filter(p => p.type === "image_url");
const notes = seen[0].filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some(p => p.type === "text" && /时间较早/.test(p.text)));
ok(imgs.length === MAX_REQUEST_IMAGES && notes.length === 2, "一次请求最多 20 张图，最早的两张换成说明");

console.log("[9] 四种协议的请求形态");
const msgs = [{ role: "system", content: "sys" }, mat[2]];
const b64 = Buffer.from(imgA).toString("base64");
const reqOf = protocol => JSON.parse(new LlmClient({ protocol, baseUrl: "https://example.test/v1", apiKey: "k", model: "m" }).buildRequest(msgs, {}).init.body);
const openai = reqOf("openai");
ok(openai.messages[1].content[0].image_url.url === "data:image/png;base64," + b64 && openai.messages[1].content[2].text === "这两张呢", "OpenAI Chat：image_url data URL");
const responses = reqOf("openai-responses");
const rcontent = responses.input.find(x => x.role === "user").content;
ok(rcontent[0].type === "input_image" && rcontent[0].image_url === "data:image/png;base64," + b64 && rcontent[2].type === "input_text", "Responses：input_image");
const anthropic = reqOf("anthropic");
const acontent = anthropic.messages[0].content;
ok(acontent[0].type === "image" && acontent[0].source.type === "base64" && acontent[0].source.media_type === "image/png" && acontent[0].source.data === b64 && acontent[1].source.media_type === "image/jpeg" && acontent[2].text === "这两张呢", "Anthropic：base64 image 块，图在文字前");
const gemini = reqOf("gemini");
const gparts = gemini.contents[0].parts;
ok(gparts[0].inlineData.mimeType === "image/png" && gparts[0].inlineData.data === b64 && gparts[2].text === "这两张呢", "Gemini：inlineData");

console.log("[10] AgentSession：按「图片输入」设置决定发图、截图回喂");
const sessStore = new ConversationStore({ memoryOnly: true });
const st = await sessStore.createThread();
const sref = await sessStore.saveImage(imgA, { width: 1600, height: 900 });
await sessStore.appendMessage(st.id, { role: "user", content: "看图", images: [sref] });
const sessCfg = new ConfigStore();
sessCfg.setContextStrategy("legacy");
let support = null;
const turns = [];
const session = await loadAgentSession({
  configStore: sessCfg,
  providers: { buildClientFromStore: () => ({ model: "m" }), resolveImageInput: () => ({ supported: support }) },
  conversationStore: {
    getThread: id => sessStore.getThread(id),
    getModelMessages: (id, o) => sessStore.getModelMessages(id, o),
    materializeImages: (m, o) => sessStore.materializeImages(m, o),
  },
  agentLoop: {
    createRunState,
    async runAgentTurn(o) {
      turns.push({ vision: o.vision, messages: o.messages });
      return { content: "done", stopReason: "final", messages: o.messages };
    },
  },
});
for (const value of [null, true, false]) {
  support = value;
  await session.run(st.id, { systemPrompt: "s", convo: [] });
}
const [unknownTurn, onTurn, offTurn] = turns;
ok(Array.isArray(unknownTurn.messages[0].content) && unknownTurn.messages[0].content[0].type === "image_url" && unknownTurn.vision === false, "认不出的模型：照发用户的图，但不回喂截图");
ok(Array.isArray(onTurn.messages[0].content) && onTurn.vision === true, "确定能看图：发图，也回喂截图");
ok(typeof offTurn.messages[0].content === "string" && /当前模型不支持看图/.test(offTurn.messages[0].content) && offTurn.vision === false, "确定不能看图：换成文字说明，不让请求被拒");

console.log(`\nImages selftest: ${passed} passed, 0 failed`);
