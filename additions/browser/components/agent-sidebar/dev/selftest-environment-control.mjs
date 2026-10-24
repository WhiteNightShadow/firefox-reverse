/* dev/selftest-environment-control.mjs — 环境浏览器里的退出通道（EnvironmentControl）。
 * 只有跑在环境自己 profile 上的浏览器才监听；上次留下的请求不会让新启动的浏览器退出；pid、envId 都对得上的
 * 请求才会让浏览器像 Marionette:Quit 一样正常退出；后端的就绪判断、请求与撤回。
 *
 *   node dev/selftest-environment-control.mjs
 */
import assert from "node:assert/strict";

const files = new Map(); // 内存文件系统：路径 → JSON 文本
const sep = "/";
globalThis.PathUtils = { join: (...parts) => parts.join(sep) };
globalThis.IOUtils = {
  async readJSON(p) {
    if (!files.has(p)) {
      throw new Error("NotFoundError: " + p);
    }
    return JSON.parse(files.get(p));
  },
  async writeJSON(p, data) {
    files.set(p, JSON.stringify(data));
  },
  async exists(p) {
    return files.has(p);
  },
  async remove(p, { ignoreAbsent = true } = {}) {
    if (!files.delete(p) && !ignoreAbsent) {
      throw new Error("NotFoundError: " + p);
    }
  },
};
const quits = [];
const notified = [];
let envVars = {};
let profile = "";
globalThis.Cc = { "@mozilla.org/supports-PRBool;1": { createInstance: () => ({ data: false }) } };
globalThis.Ci = { nsIFile: {}, nsISupportsPRBool: {}, nsIAppStartup: { eForceQuit: 0x30 } };
globalThis.Services = {
  env: { get: name => envVars[name] || "" },
  dirsvc: { get: () => ({ path: profile }) },
  appinfo: { processID: 4321 },
  obs: { notifyObservers: (_subject, topic) => notified.push(topic) },
  startup: { quit: mode => quits.push(mode) },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let instance = 0;
// 模块里每个进程只有一个监听者：每个场景重新加载一份模块，模拟一个新的浏览器进程。
const freshModule = () => import(`../modules/EnvironmentControl.sys.mjs?process=${++instance}`);

const root = "/home/u/.firefox-reverse/environments";
const control = id => `${root}/${id}/control`;
const ready = id => `${control(id)}/quit-channel.json`;
const request = id => `${control(id)}/quit-request.json`;

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass++;
  console.log("  ✓", msg);
};

console.log("[1] 主浏览器和继承了环境变量的其他进程不监听");
{
  envVars = {};
  profile = "/home/u/Library/FirefoxReverse/Profiles/main.default";
  const { EnvironmentControl } = await freshModule();
  await EnvironmentControl.firstWindowReady();
  EnvironmentControl.quitGranted();
  ok(files.size === 0, "主浏览器（没有环境变量）不写任何文件");

  envVars = { MOZ_FRX_ENV_ID: "env_a", MOZ_FRX_CONTROL_DIR: control("env_a") };
  const other = await freshModule();
  await other.EnvironmentControl.firstWindowReady();
  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_a", pid: 4321 }));
  await sleep(700);
  ok(!files.has(ready("env_a")) && quits.length === 0, "环境变量是继承来的、profile 不是该环境的：不监听，也不响应请求");
  files.clear();
}

console.log("[2] 环境浏览器：清掉上次的请求，宣布就绪，只响应对得上的请求");
{
  envVars = { MOZ_FRX_ENV_ID: "env_a", MOZ_FRX_CONTROL_DIR: control("env_a") };
  profile = `${root}/env_a/profile`;
  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_a", pid: 4321, requestedAt: "上次运行" }));
  const { EnvironmentControl } = await freshModule();
  const before = Date.now();
  await EnvironmentControl.firstWindowReady();
  ok(!files.has(request("env_a")), "上次运行留下的请求在启动时清掉，不会让刚启动的浏览器跟着退出");
  const info = JSON.parse(files.get(ready("env_a")));
  ok(info.version === 1 && info.envId === "env_a" && info.pid === 4321 && info.startedAt >= before, "就绪标记写入 envId、自己的 pid 和启动时间");

  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_a", pid: 9999 }));
  await sleep(700);
  ok(quits.length === 0 && files.has(request("env_a")), "pid 不是自己的请求不响应，也不动它");
  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_b", pid: 4321 }));
  await sleep(700);
  ok(quits.length === 0, "别的环境的请求不响应");

  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_a", pid: 4321 }));
  await sleep(700);
  ok(!files.has(request("env_a")), "对得上的请求被取走（后端据此知道请求已接收）");
  ok(notified.join() === "quit-application-requested" && quits.join() === String(Ci.nsIAppStartup.eForceQuit), "和 Marionette:Quit 一样：先广播 quit-application-requested，再 eForceQuit 正常退出");

  files.set(request("env_a"), JSON.stringify({ version: 1, envId: "env_a", pid: 4321 }));
  await sleep(700);
  ok(quits.length === 1, "已经在退出：不再轮询，不会重复退出");
  await EnvironmentControl.firstWindowReady();
  ok(quits.length === 1, "同一进程再次调用不会起第二个监听");
  files.clear();
  quits.length = 0;
  notified.length = 0;
}

console.log("[2b] 读到请求后、取走之前被后端撤回：不退出，继续等");
{
  envVars = { MOZ_FRX_ENV_ID: "env_r", MOZ_FRX_CONTROL_DIR: control("env_r") };
  profile = `${root}/env_r/profile`;
  const { EnvironmentControl } = await freshModule();
  await EnvironmentControl.firstWindowReady();
  const readJSON = IOUtils.readJSON;
  let raced = false;
  IOUtils.readJSON = async p => {
    const value = await readJSON(p);
    if (p === request("env_r") && !raced) {
      raced = true;
      files.delete(p); // 后端恰好在这一刻撤回了请求
    }
    return value;
  };
  files.set(request("env_r"), JSON.stringify({ version: 1, envId: "env_r", pid: 4321 }));
  await sleep(700);
  ok(raced && quits.length === 0, "请求已被后端撤回（它会改走 Marionette 或信号）：环境不能再自己退出");
  files.set(request("env_r"), JSON.stringify({ version: 1, envId: "env_r", pid: 4321 }));
  await sleep(700);
  IOUtils.readJSON = readJSON;
  ok(quits.length === 1 && !files.has(request("env_r")), "之后的新请求照常取走并退出");
  files.clear();
  quits.length = 0;
  notified.length = 0;
}

console.log("[3] 浏览器已在退出：停止轮询");
{
  envVars = { MOZ_FRX_ENV_ID: "env_c", MOZ_FRX_CONTROL_DIR: control("env_c") };
  profile = `${root}/env_c/profile`;
  const { EnvironmentControl } = await freshModule();
  await EnvironmentControl.firstWindowReady();
  EnvironmentControl.quitGranted();
  files.set(request("env_c"), JSON.stringify({ version: 1, envId: "env_c", pid: 4321 }));
  await sleep(700);
  ok(quits.length === 0 && files.has(request("env_c")), "quit-application-granted 之后不再处理请求");
  files.clear();
}

console.log("[4] Windows 路径");
{
  const winRoot = "C:\\Users\\白夜\\.firefox-reverse\\environments";
  envVars = { MOZ_FRX_ENV_ID: "env_w", MOZ_FRX_CONTROL_DIR: `${winRoot}\\env_w\\control` };
  profile = `${winRoot}\\env_w\\profile`;
  const { EnvironmentControl } = await freshModule();
  await EnvironmentControl.firstWindowReady();
  ok(files.has(`${winRoot}\\env_w\\control/quit-channel.json`), "反斜杠路径同样识别为该环境自己的 profile");
  EnvironmentControl.quitGranted();
  files.clear();
}

console.log("[5] 后端：就绪判断、请求、撤回");
{
  const { quitChannelReady, requestQuit, quitRequestPending, withdrawQuitRequest } = await freshModule();
  const now = Date.now();
  ok(!(await quitChannelReady(control("env_d"), "env_d", 77)), "没有就绪标记：通道不可用");
  files.set(ready("env_d"), JSON.stringify({ version: 1, envId: "env_d", pid: 77, startedAt: now }));
  ok(await quitChannelReady(control("env_d"), "env_d", 77, now - 5000), "pid、envId 对得上且晚于这次启动：可用");
  ok(!(await quitChannelReady(control("env_d"), "env_d", 78, now - 5000)), "pid 对不上：不可用");
  ok(!(await quitChannelReady(control("env_d"), "env_e", 77, now - 5000)), "envId 对不上：不可用");
  ok(!(await quitChannelReady(control("env_d"), "env_d", 77, now + 60000)), "标记早于这次启动（上次运行留下的）：不可用");
  files.set(ready("env_d"), JSON.stringify({ version: 2, envId: "env_d", pid: 77, startedAt: now }));
  ok(!(await quitChannelReady(control("env_d"), "env_d", 77)), "协议版本不同：不可用");
  await requestQuit(control("env_d"), "env_d", "77");
  const req = JSON.parse(files.get(request("env_d")));
  ok(req.version === 1 && req.envId === "env_d" && req.pid === 77 && typeof req.requestedAt === "string", "请求里带 envId 和数值 pid");
  ok(await quitRequestPending(control("env_d")), "请求在等待被取走");
  ok((await withdrawQuitRequest(control("env_d"))) === true && !files.has(request("env_d")), "没被取走的请求可以撤回");
  ok((await withdrawQuitRequest(control("env_d"))) === false, "已经不在（被环境抢先取走）时返回 false，调用方按已接收处理");
}

console.log(`\nEnvironmentControl selftest: ${pass} passed`);
