/* dev/selftest-paste-images.mjs — 侧栏输入框粘贴/拖入图片（#44）：在 jsdom 里挂真的 AgentPanel 和真的
 * ConversationStore（内存模式），模拟粘贴、拖放、删除、发送。图片解码压缩在浏览器里做，这里换成假的 prepareImage，
 * 真引擎里的解码压缩另有实测。
 *
 *   node dev/selftest-paste-images.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

process.env.NODE_ENV = "production";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
globalThis.Services = { wm: { getMostRecentWindow: () => ({ browsingContext: {} }) }, prefs: { getBoolPref: () => true, setBoolPref() {} } };

let passed = 0;
const ok = (cond, name) => {
  assert.ok(cond, name);
  passed++;
  console.log("  ✓", name);
};

const runs = [];
const session = {
  isRunning: () => false,
  getState: () => null,
  acquireThread: ids => ids[0],
  renewThread: () => true,
  releaseThread() {},
  takeOverThread: id => id,
  listRunning: () => [],
  respondConfirm() {},
  stop() {},
  run: async (tid, options) => {
    runs.push({ tid, options });
  },
};

// 当前模型配置：测试里改 model / imageInput 模拟切换配置
const profile = { model: "MiniMax-M3", imageInput: "auto" };
const store = { getActiveModelProfile: () => ({ ...profile }), getConfirmTools: () => false };

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const pngBytes = (size, seed) => {
  const b = new Uint8Array(size).fill(seed);
  b.set(PNG_HEAD, 0);
  return b;
};
// 假的图片文件和处理函数：真引擎里是 createImageBitmap + canvas
const file = (name, type = "image/png", size = 2000, seed = 1) => ({ name, type, size, bytes: pngBytes(size, seed) });
const prepared = [];
const prepareImage = async f => {
  prepared.push(f.name);
  await sleep(5);
  if (f.name.startsWith("broken")) {
    throw new Error("读不出这张图片（格式不支持或文件损坏）");
  }
  return { bytes: f.bytes, mime: "image/png", width: 2000, height: 1125, sourceWidth: 3456, sourceHeight: 1944, name: f.name };
};
const clipboard = ({ files = [], text = "" } = {}) => ({
  items: [
    ...(text ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : []),
    ...files.map(f => ({ kind: "file", type: f.type, getAsFile: () => f })),
  ],
  files,
  types: [...(text ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
  getData: type => (type === "text/plain" ? text : ""),
});

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.paste-images-test-"));
let root = null;
try {
  await build({
    absWorkingDir: sidebar,
    entryPoints: ["content/AgentPanel.jsx"],
    outdir: temp,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react", "react-dom"],
    outExtension: { ".js": ".mjs" },
    logLevel: "error",
  });
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { default: AgentPanel } = await import(pathToFileURL(join(temp, "AgentPanel.mjs")));
  const { ConversationStore } = await import(pathToFileURL(join(sidebar, "modules/ConversationStore.sys.mjs")));
  const { resolveImageInput } = await import(pathToFileURL(join(sidebar, "modules/providers.sys.mjs")));

  const conversations = new ConversationStore({ memoryOnly: true });
  const mount = async () => {
    if (root) root.unmount();
    root = createRoot(document.getElementById("root"));
    root.render(React.createElement(AgentPanel, { conversations, session, store, router: {}, buildClient: () => ({}), resolveImageInput, prepareImage }));
    await sleep(250);
  };
  const textarea = () => document.querySelector(".agent-panel__input textarea");
  const sendButton = () => [...document.querySelectorAll(".agent-panel__input button")].find(b => b.textContent.trim() === "发送");
  const thumbs = () => [...document.querySelectorAll(".agent-attach__item img")];
  const noteText = () => [...document.querySelectorAll(".agent-attach__note, .agent-attach__warn")].map(n => n.textContent).join(" | ");
  const fire = async (el, type, props) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(props || {})) Object.defineProperty(event, k, { value: v });
    el.dispatchEvent(event);
    await sleep(80);
    return event;
  };
  const paste = (data) => fire(textarea(), "paste", { clipboardData: clipboard(data) });
  const type = async value => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea(), value);
    textarea().dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(30);
  };
  const click = async el => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(200);
  };

  await mount();
  ok(/可粘贴图片/.test(textarea().getAttribute("placeholder")), "输入框提示可以粘贴图片");
  ok(sendButton().disabled, "没文字也没图片时不能发送");

  console.log("[1] 粘贴");
  let ev = await paste({ text: "只是一段文字" });
  ok(!ev.defaultPrevented && !thumbs().length, "只有文字：照常粘贴文字");
  ev = await paste({ files: [file("shot.png")] });
  ok(ev.defaultPrevented && thumbs().length === 1 && thumbs()[0].getAttribute("src").startsWith("blob:"), "截图：拦下默认粘贴，放进待发送图片（blob: 预览）");
  ok(!sendButton().disabled, "只有图片也能发送");
  const title = document.querySelector(".agent-attach__item").getAttribute("title");
  ok(/2000×1125 PNG/.test(title) && /原图 3456×1944 已缩小/.test(title), "缩略图提示尺寸和大小，说明原图缩小过");
  ev = await paste({ files: [file("table.png")], text: "名称\t数量\n苹果\t3" });
  ok(!ev.defaultPrevented && thumbs().length === 1, "Excel/Word 这种文字和渲染图一起复制的：贴文字，不加图");
  ev = await paste({ files: [file("copied.png", "image/png", 2000, 2)], text: "https://example.com/static/a.png" });
  ok(ev.defaultPrevented && thumbs().length === 2, "浏览器「复制图片」（文字只是图片地址）：贴图片，不贴地址");
  ev = await paste({ files: [file("Screen Shot 2026-11-11 at 10.00.00.png", "image/png", 2000, 3)], text: "Screen Shot 2026-11-11 at 10.00.00.png" });
  ok(ev.defaultPrevented && thumbs().length === 3, "文字只是图片文件名：贴图片");
  ok(/没认出当前模型（MiniMax-M3）能不能看图，会照常发送/.test(noteText()), "认不出的模型：提示会照常发送、出错再改设置");

  console.log("[2] 删除、上限、处理失败");
  await click(document.querySelector(".agent-attach__remove"));
  ok(thumbs().length === 2, "点 × 删掉一张");
  await paste({ files: Array.from({ length: 8 }, (_, i) => file("many" + i + ".png", "image/png", 2000, 10 + i)) });
  ok(thumbs().length === 8 && /一条消息最多带 8 张图片，多出的 2 张没加上/.test(noteText()), "一条消息最多 8 张，多出的说明没加上");
  await paste({ files: [file("one-more.png")] });
  ok(thumbs().length === 8 && /最多带 8 张/.test(noteText()), "满了再贴：提示已满");
  while (thumbs().length) await click(document.querySelector(".agent-attach__remove"));
  await paste({ files: [file("broken.heic", "image/heic")] });
  ok(!thumbs().length && /broken.heic：读不出这张图片/.test(noteText()), "读不出的图片：说明哪一张、为什么");
  await paste({ files: [file("big1.png", "image/png", 3_400_000, 21), file("big2.png", "image/png", 3_400_000, 22), file("big3.png", "image/png", 3_400_000, 23)] });
  ok(thumbs().length === 2 && /合计超过 8MB，big3.png没加上/.test(noteText()), "一条消息的图片合计超过 8MB 时不加，说明是哪张");
  while (thumbs().length) await click(document.querySelector(".agent-attach__remove"));

  console.log("[3] 拖放");
  const composer = document.querySelector(".agent-panel__composer");
  const dropData = files => ({ ...clipboard({ files }), dropEffect: "none" });
  ev = await fire(composer, "dragover", { dataTransfer: dropData([file("drag.png")]) });
  ok(ev.defaultPrevented && composer.classList.contains("is-dragover"), "拖着文件经过：可以放下，输入区描虚线框");
  ev = await fire(composer, "drop", { dataTransfer: dropData([file("drag.png", "image/png", 2000, 30)]) });
  ok(ev.defaultPrevented && thumbs().length === 1 && !composer.classList.contains("is-dragover"), "放下图片：加进待发送");
  ev = await fire(composer, "drop", { dataTransfer: dropData([{ name: "notes.txt", type: "text/plain", size: 10 }]) });
  ok(ev.defaultPrevented && thumbs().length === 1 && /只能拖入图片文件/.test(noteText()), "拖进不是图片的文件：提示只能拖图片");
  ev = await fire(composer, "drop", { dataTransfer: { items: [], files: [], types: ["text/plain"], getData: () => "x" } });
  ok(!ev.defaultPrevented, "拖进文字：照常插进输入框");

  console.log("[4] 模型不能看图时拦下");
  profile.model = "deepseek-v4-flash";
  await type("看看这张图");
  ok(/当前模型（deepseek-v4-flash）不支持看图/.test(noteText()), "不能看图的模型：输入区直接提示");
  await click(sendButton());
  ok(!runs.length && thumbs().length === 1 && textarea().value === "看看这张图", "发送被拦下，图片和文字都留着");
  ok(/不支持看图/.test(document.querySelector(".agent-panel__error")?.textContent || ""), "报错说明原因和怎么改");
  profile.imageInput = "on";
  await type("看看这张图 ");
  ok(!/不支持看图/.test(noteText()), "设置里改成「支持」后不再提示");

  console.log("[5] 发送");
  await type("这张截图里的签名参数是什么");
  await click(sendButton());
  await sleep(200);
  ok(runs.length === 1, "发送后开始执行");
  const convo = runs[0].options.convo;
  const last = convo.at(-1);
  ok(last.role === "user" && last.content === "这张截图里的签名参数是什么" && last.images.length === 1 && /^[0-9a-f]{64}$/.test(last.images[0].id), "交给引擎的消息带图片引用");
  const thread = await conversations.getThread(runs[0].tid);
  ok(thread.messages[0].images[0].id === last.images[0].id && conversations._images.has(last.images[0].id), "图片存进会话存储，消息里只记引用");
  ok(!thumbs().length && textarea().value === "", "发送后清空文字和待发送图片");
  await sleep(150);
  const bubbleImg = document.querySelector(".msg--user .msg__images img");
  ok(bubbleImg && bubbleImg.getAttribute("src").startsWith("blob:") && /2000×1125 PNG/.test(bubbleImg.getAttribute("alt")), "用户消息里显示这张图");
  await click(bubbleImg);
  ok(bubbleImg.classList.contains("is-expanded"), "点图片放大");

  console.log("[6] 只发图片；重新打开会话时图片还在");
  await mount(); // 上一轮还「在跑」（替身引擎不收尾），重新挂一个空闲的面板
  runs.length = 0;
  await paste({ files: [file("only.png", "image/png", 2000, 40)] });
  await click(sendButton());
  await sleep(200);
  ok(runs.length === 1 && runs[0].options.convo.at(-1).content === "" && runs[0].options.convo.at(-1).images.length === 1, "不写文字只发图片也行");
  const tid = runs[0].tid;
  ok((await conversations.getThread(tid)).messages.at(-1).images.length === 1, "只有图片的消息也存下来了");
  const lost = { id: "e".repeat(64), mime: "image/png", width: 10, height: 10, size: 10 };
  await conversations.appendMessage(tid, { role: "user", content: "文件被删的图", images: [lost] });
  await mount();
  await sleep(300);
  const shown = document.querySelectorAll(".msg--user .msg__images img");
  ok(shown.length >= 1 && [...shown].every(img => img.getAttribute("src").startsWith("blob:")), "重新打开会话：之前发的图片从存储里读出来显示");
  ok(/图片已不在：10×10 PNG/.test(document.querySelector(".msg__image--missing")?.textContent || ""), "图片文件不在了：显示说明，不报错");
  console.log(`\nPaste images selftest: ${passed} passed, 0 failed`);
} finally {
  if (root) root.unmount();
  await rm(temp, { recursive: true, force: true });
}
