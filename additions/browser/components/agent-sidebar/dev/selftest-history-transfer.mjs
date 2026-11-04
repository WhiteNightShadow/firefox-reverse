/* dev/selftest-history-transfer.mjs — 历史抽屉的「全部导出」和「导入」（#7）：在办公电脑上把全部会话导出成一个文件，
 * 回家后一次导回；再导一次不重复导入；单会话文件照样能导。用真的 ConversationStore（内存模式，IOUtils 接到 node 的文件系统）
 * 和一个假的文件选择器，点按钮走完整流程。
 *
 *   node dev/selftest-history-transfer.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// 文件读写走 node；ConversationStore 本身用内存模式，只有导出/导入文件时才碰 IOUtils。
globalThis.IOUtils = {
  writeUTF8: async (path, text) => writeFile(path, text, "utf8"),
  readUTF8: async path => readFile(path, "utf8"),
  stat: async path => ({ size: (await stat(path)).size }),
};
globalThis.PathUtils = {};

// 假的文件选择器：nextPath 是「用户选中的文件」，picks 记下每次打开时的标题、模式、过滤器和默认文件名。
let nextPath = null;
const picks = [];
const FilePicker = { modeOpen: 0, modeSave: 1, modeGetFolder: 2, returnOK: 0, returnCancel: 1, returnReplace: 2, filterAll: 1 };
globalThis.Ci = { nsIFilePicker: FilePicker, nsIFile: {} };
globalThis.Cc = {
  "@mozilla.org/filepicker;1": {
    createInstance: () => {
      const pick = { filters: [] };
      picks.push(pick);
      return {
        init: (_ctx, title, mode) => Object.assign(pick, { title, mode }),
        appendFilter: (_name, pattern) => pick.filters.push(pattern),
        appendFilters: () => {},
        set defaultString(v) { pick.defaultString = v; },
        set defaultExtension(v) { pick.defaultExtension = v; },
        get file() { return nextPath ? { path: nextPath } : null; },
        open: callback => setTimeout(() => callback(nextPath ? FilePicker.returnOK : FilePicker.returnCancel), 0),
      };
    },
  },
};
globalThis.Services = {
  wm: { getMostRecentWindow: () => ({ browsingContext: {} }) },
  prefs: { getBoolPref: () => true, setBoolPref() {} },
};

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
  run: async () => {},
};

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.history-transfer-test-"));
const files = await mkdtemp(join(tmpdir(), "frx-history-transfer-"));
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

  const button = title => [...document.querySelectorAll("button")].find(b => b.textContent === title || b.getAttribute("title") === title);
  const click = async el => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(150);
  };
  // 打开一个会话会顺手关掉历史抽屉；点抽屉里的按钮前先确认它开着。
  const historyButton = async title => {
    if (!document.querySelector(".agent-history")) {
      await click(button("历史对话"));
    }
    return button(title);
  };
  const notice = () => [...document.querySelectorAll("span")].map(s => s.textContent).find(t => /会话/.test(t) && /导/.test(t)) || "";
  const mount = async conversations => {
    if (root) {
      root.unmount();
    }
    root = createRoot(document.getElementById("root"));
    root.render(React.createElement(AgentPanel, { conversations, session, store: {}, router: {}, buildClient: () => ({}) }));
    await sleep(300);
    await click(button("历史对话"));
  };

  // 办公电脑：两个有内容的会话，外加一个空会话
  const office = new ConversationStore({ memoryOnly: true });
  const a = await office.createThread();
  await office.appendMessage(a.id, { role: "user", content: "签名入口在哪" });
  await office.appendMessage(a.id, { role: "assistant", content: "在 sign()" });
  await office.renameThread(a.id, "签名分析");
  await office.createThread();
  const b = await office.createThread();
  await office.appendMessage(b.id, { role: "user", content: "抓一下登录请求" });
  await office.renameThread(b.id, "登录抓包");
  await mount(office);

  const exportAll = await historyButton("全部导出");
  assert(exportAll && !exportAll.disabled, "历史抽屉里有「全部导出」，有会话时可用");
  const bundlePath = join(files, "all.frx-chats.json");
  nextPath = bundlePath;
  await click(exportAll);
  const savePick = picks.at(-1);
  assert.equal(savePick.mode, FilePicker.modeSave, "导出全部打开的是保存对话框");
  assert.match(savePick.defaultString, /^firefox-reverse-conversations-\d{8}\.frx-chats\.json$/, "默认文件名带日期和 .frx-chats.json");
  assert(savePick.filters.some(f => f.includes("*.frx-chats.json") && f.includes("*.frx-chat.json")), "文件过滤器两种扩展名都认");
  const written = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(written.format, "firefox-reverse-conversations");
  assert.deepEqual(written.conversations.map(c => c.title), ["登录抓包", "签名分析"], "文件里是两个有内容的会话，按最近更新排序");
  assert.match(notice(), /已导出 2 个会话，1 个空会话没有导出/, "提示导出了几个、跳过了几个空会话");

  // 家里的电脑：一次导回
  const home = new ConversationStore({ memoryOnly: true });
  await mount(home);
  nextPath = bundlePath;
  await click(await historyButton("导入"));
  assert.equal(picks.at(-1).mode, FilePicker.modeOpen, "导入打开的是打开文件对话框");
  const titles = (await home.listThreads()).filter(t => t.count > 0).map(t => t.title);
  assert.deepEqual(titles, ["登录抓包", "签名分析"], "两个会话都导进来了，先后顺序不变");
  assert.match(notice(), /已导入 2 个会话/, "提示导入了几个");
  const items = [...document.querySelectorAll(".agent-history__item")].map(el => el.getAttribute("title"));
  assert(items.includes("登录抓包") && items.includes("签名分析"), "历史列表刷新出导入的会话");

  // 再导一次：不重复
  await click(await historyButton("导入"));
  assert.equal((await home.listThreads()).filter(t => t.count > 0).length, 2, "同一个文件再导一次不重复导入");
  assert.match(notice(), /这 2 个会话之前都已导入过，没有重复导入/, "提示都已导入过");

  // 单会话文件：导入过的直接打开已有的那个；新的作为新对话导入
  const singlePath = join(files, "one.frx-chat.json");
  await writeFile(singlePath, await office.exportThreadJSON(a.id), "utf8");
  nextPath = singlePath;
  await click(await historyButton("导入"));
  assert.match(notice(), /这个会话之前已导入过，没有重复导入/, "单会话文件导入过也不重复");
  await office.appendMessage(a.id, { role: "user", content: "办公室又问了一句" });
  await writeFile(singlePath, await office.exportThreadJSON(a.id), "utf8");
  await click(await historyButton("导入"));
  assert.match(notice(), /会话已作为新对话导入/, "来源更新过的单会话作为新对话导入");
  assert.equal((await home.listThreads()).filter(t => t.count > 0).length, 3);

  // 坏文件：报错，不导入
  const badPath = join(files, "bad.frx-chats.json");
  await writeFile(badPath, '{"format":"firefox-reverse-conversations","schemaVersion":1,"conversations":[{"messages":[{"role":"system","content":"x"}]}]}', "utf8");
  nextPath = badPath;
  await click(await historyButton("导入"));
  assert.match(document.querySelector(".agent-panel__error")?.textContent || "", /第 1 个会话：第 1 条消息角色无效/, "坏文件报出原因");
  assert.equal((await home.listThreads()).filter(t => t.count > 0).length, 3, "坏文件一个都不导入");

  // 只有空会话时「全部导出」不可用：新 profile 里只有挂载时建的那个空会话
  const empty = new ConversationStore({ memoryOnly: true });
  await mount(empty);
  nextPath = join(files, "nothing.frx-chats.json");
  await click(await historyButton("全部导出"));
  assert.match(document.querySelector(".agent-panel__error")?.textContent || "", /没有可导出的会话/, "全是空会话时提示没有可导出的");

  console.log("history transfer selftest: all passed");
} finally {
  if (root) {
    root.unmount();
  }
  await rm(temp, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
}
