/* dev/selftest-panel-live.mjs — 侧栏实时区的轮询：引擎状态版本（rev）没变时跳过这一拍；实时区被清空后
 * （比如在历史里点开正在运行的当前会话）要重新显示，等工具确认时确认条不能消失；版本变化时显示跟着更新。
 *
 *   node dev/selftest-panel-live.mjs
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

// 假引擎：会话 T1 正在运行，停在等工具确认上（这期间引擎状态不变，rev 也不变）
const state = {
  rev: 7,
  running: true,
  settled: false,
  checkpointSeq: 0,
  error: null,
  usage: {},
  steps: [{ kind: "text", text: "我先执行一段脚本。" }, { kind: "tool", id: "c1", name: "page_eval", status: "running" }],
  pendingConfirm: { id: "c1", name: "page_eval", args: { expression: "1+1" } },
};
const session = {
  isRunning: id => id === "T1" && state.running,
  getState: id => (id === "T1" ? { ...state, steps: state.steps.slice(), pendingConfirm: state.pendingConfirm && { ...state.pendingConfirm } } : null),
  acquireThread: ids => ids[0],
  renewThread: () => true,
  releaseThread() {},
  takeOverThread: id => id,
  listRunning: () => (state.running ? [{ id: "T1", nSteps: state.steps.length, checkpointSeq: 0 }] : []),
  respondConfirm() {},
  stop() {},
  run: async () => {},
};
const conversations = {
  listThreads: async () => [{ id: "T1", title: "当前任务", updatedAt: Date.now(), count: 1 }],
  getThread: async id => ({ id, messages: [{ role: "user", content: "帮我分析" }], usage: null, mode: "auto" }),
  createThread: async () => ({ id: "T2", messages: [] }),
  appendMessage: async () => {},
  setThreadMode: async () => {},
};

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.panel-live-test-"));
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
  root = createRoot(document.getElementById("root"));
  root.render(React.createElement(AgentPanel, { conversations, session, store: {}, router: {}, buildClient: () => ({}) }));
  const shown = () => ({
    confirm: !!document.querySelector(".agent-confirm"),
    live: document.querySelector(".msg__content--live")?.textContent || "",
  });

  await sleep(400);
  const before = shown();
  assert(before.confirm && before.live.includes("我先执行一段脚本"), "空闲的侧栏跟随正在运行的会话，显示实时步骤和确认条");

  // 在历史里点开正在运行的当前会话：实时区被清空，引擎状态没变，下一拍仍要重新显示
  [...document.querySelectorAll("button")].find(b => b.getAttribute("title") === "历史对话").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  document.querySelector(".agent-history__item.is-current").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);
  const after = shown();
  assert(after.confirm, "等工具确认时，确认条不会因为重新打开当前会话而消失");
  assert(after.live.includes("我先执行一段脚本"), "实时步骤重新显示");

  // 版本没变：这一拍跳过（模拟的步骤变化不显示）；版本前进：显示跟着更新
  state.steps = [...state.steps, { kind: "text", text: "新的进展" }];
  await sleep(300);
  assert(!shown().live.includes("新的进展"), "引擎状态版本没变时跳过这一拍");
  state.rev++;
  await sleep(300);
  assert(shown().live.includes("新的进展"), "版本前进后显示更新");
  console.log("panel live polling selftest: 5 passed");
} finally {
  root?.unmount();
  await rm(temp, { recursive: true, force: true });
}
process.exit(0);
