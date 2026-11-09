/* dev/selftest-hook-preset.mjs — hook_inject 的内置 hook（AgentEvalChild 里的 FRX_HOOK_PRESET）装进页面之后，
 * 页面自己的请求还发得出去。
 * 真浏览器里 hook 是在一个以页面 window 为原型的沙箱里 evalInSandbox 的（Cu.Sandbox(win, { sandboxPrototype: win })）：
 * 页面代码裸调用 fetch(url) 时 this 是 undefined，落到包装函数所在沙箱的全局，不是页面 window，原生 fetch 对这样的
 * this 抛 TypeError——v0.27.1 上装了 hook 的页面发 fetch 直接失败，只有 window.fetch(url) 和 XHR 正常。
 * 这里用 node 的 vm 搭同样的结构：上下文的全局对象以假 window 为原型，假 fetch 像原生方法一样检查 this。
 * 跑：node dev/selftest-hook-preset.mjs */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let pass = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  pass++;
  console.log("  ✓", message);
};

const source = await readFile(new URL("../modules/AgentEvalChild.sys.mjs", import.meta.url), "utf8");
const match = /const FRX_HOOK_PRESET = `([\s\S]*?)`;\n/.exec(source);
assert.ok(match, "AgentEvalChild.sys.mjs 里有 FRX_HOOK_PRESET");
const preset = match[1];

/** 假页面：window.fetch / XMLHttpRequest / navigator.sendBeacon 都记下实际发出的请求；fetch 像 WebIDL 方法一样检查 this。 */
function makePage() {
  const sent = [];
  const win = {};
  win.window = win;
  win.fetch = function fetch(input) {
    if (this !== win) {
      throw new TypeError("'fetch' called on an object that does not implement interface Window.");
    }
    sent.push("fetch " + String(input));
    return Promise.resolve({ status: 200 });
  };
  win.XMLHttpRequest = class {
    open(method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      sent.push("xhr " + this.url);
    }
  };
  win.navigator = {
    sendBeacon(url) {
      sent.push("beacon " + String(url));
      return true;
    },
  };
  win.Headers = class {
    forEach() {}
  };
  return { win, sent };
}

/** 像 hook_inject 那样把 hook 装进页面：上下文全局以页面 window 为原型。 */
function inject(win, code) {
  const sandbox = Object.create(win);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
}

console.log("[1] 装上内置 hook 之后，页面自己的请求照常发出");
{
  const { win, sent } = makePage();
  inject(win, preset);
  const bare = win.fetch; // 页面里写的是 fetch(url)：this 是 undefined
  await bare("/api/sign?bare");
  await win.fetch("/api/sign?window");
  const xhr = new win.XMLHttpRequest();
  xhr.open("GET", "/api/sign?xhr");
  xhr.send();
  win.navigator.sendBeacon("/api/beat");
  check(sent.includes("fetch /api/sign?bare"), "页面裸调用 fetch(url)：请求发出去了（v0.27.1 上这里抛 TypeError）");
  check(sent.includes("fetch /api/sign?window") && sent.includes("xhr /api/sign?xhr") && sent.includes("beacon /api/beat"), "window.fetch、XHR、sendBeacon 照常");
  check(
    win.__frxhook.map(r => r.api + " " + r.url).join(",") === "fetch /api/sign?bare,fetch /api/sign?window,xhr /api/sign?xhr,beacon /api/beat",
    "四次请求都记进 window.__frxhook"
  );
  inject(win, preset);
  await bare("/api/sign?again");
  check(sent.filter(s => s === "fetch /api/sign?again").length === 1 && win.__frxhook.length === 5, "再装一次不重复包装，只记一次");
}

console.log("[2] 对照：包装里用 this 调原函数就会坏");
{
  const { win, sent } = makePage();
  inject(win, preset.replace("return of.apply(window, arguments);", "return of.apply(this, arguments);"));
  const bare = win.fetch;
  await assert.rejects(() => Promise.resolve().then(() => bare("/api/sign?bare")), /does not implement interface Window/);
  check(!sent.includes("fetch /api/sign?bare"), "这个 selftest 搭的结构能复现 v0.27.1 的问题：裸调用的请求没有发出去");
}

console.log(`\nhook preset selftest: ${pass} passed`);
