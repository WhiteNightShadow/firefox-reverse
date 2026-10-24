/* EnvironmentControl.sys.mjs — 环境浏览器里的退出通道。
 *
 * 侧栏关闭环境时，先往环境的 control 目录写一个退出请求，由环境浏览器自己正常退出，cookie、
 * localStorage、会话照常落盘。这条路不经过 Marionette：外部 MCP/WebDriver 正占着环境的 Marionette
 * 会话时，后端的连接会被直接拒绝，以前只能退回发信号，而 macOS 上 Firefox 不处理 SIGTERM，等于强杀。
 *
 * 约定（都在 <环境目录>/control 下）：
 *   quit-channel.json  环境浏览器第一个窗口就绪后写入 { version, envId, pid, startedAt }，表示在监听。
 *   quit-request.json  后端写入 { version, envId, pid, requestedAt }。envId 和 pid 都对得上的环境浏览器
 *                      取走它（删除文件）并退出；后端看文件被取走，就知道请求已被接收。
 * 只有 profile 正是 <环境目录>/profile 的浏览器才监听：环境变量会被子进程继承，主浏览器和别的进程不受影响。
 * 环境端由 agent-sidebar.manifest 里的 browser-first-window-ready 分类调用。
 */

import { cancelTimeout, scheduleTimeout } from "./EnvironmentCommon.sys.mjs";

const VERSION = 1;
const READY_FILE = "quit-channel.json";
const REQUEST_FILE = "quit-request.json";
const POLL_MS = 500;

function controlFiles(controlDir) {
  return {
    ready: PathUtils.join(controlDir, READY_FILE),
    request: PathUtils.join(controlDir, REQUEST_FILE),
  };
}

function normalizedPath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// ── 环境浏览器这一端 ──

let watcher = null;

function quitBrowser() {
  // 与 Marionette:Quit（eForceQuit）相同：先广播退出请求，让会话恢复等组件收集最后状态，再强制退出。
  const cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancelQuit, "quit-application-requested");
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}

async function poll() {
  watcher.timer = null;
  if (watcher.stopped) {
    return;
  }
  let request = null;
  try {
    request = await IOUtils.readJSON(watcher.files.request);
  } catch {
    // 没有请求
  }
  if (watcher.stopped) {
    return;
  }
  if (request && request.envId === watcher.envId && Number(request.pid) === watcher.pid) {
    // 取走请求和后端撤回请求删的是同一个文件，只有一方能删成功：删成功才退出。删不掉说明后端刚好撤回、
    // 已经改走别的关闭方式，这边继续等下一个请求。
    try {
      await IOUtils.remove(watcher.files.request, { ignoreAbsent: false });
    } catch {
      if (!watcher.stopped) {
        watcher.timer = scheduleTimeout(poll, POLL_MS);
      }
      return;
    }
    if (watcher.stopped) {
      return; // 浏览器已经在退出
    }
    watcher.stopped = true;
    quitBrowser();
    return;
  }
  watcher.timer = scheduleTimeout(poll, POLL_MS);
}

export const EnvironmentControl = {
  async firstWindowReady() {
    if (watcher) {
      return;
    }
    const envId = Services.env.get("MOZ_FRX_ENV_ID");
    const controlDir = Services.env.get("MOZ_FRX_CONTROL_DIR");
    if (!envId || !controlDir) {
      return;
    }
    let profile = "";
    try {
      profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    } catch {
      return;
    }
    const control = normalizedPath(controlDir);
    if (!control.endsWith(`/${envId}/control`) || !normalizedPath(profile).endsWith(`/${envId}/profile`)) {
      return;
    }
    watcher = { envId, pid: Services.appinfo.processID, files: controlFiles(controlDir), timer: null, stopped: false };
    // 上一次运行留下的请求不能让这次刚启动的浏览器跟着退出。
    await IOUtils.remove(watcher.files.request, { ignoreAbsent: true });
    await IOUtils.writeJSON(
      watcher.files.ready,
      { version: VERSION, envId, pid: watcher.pid, startedAt: Date.now() },
      { tmpPath: watcher.files.ready + ".tmp" }
    );
    if (!watcher.stopped) {
      watcher.timer = scheduleTimeout(poll, POLL_MS);
    }
  },

  // 浏览器已在退出：停止轮询。
  quitGranted() {
    if (!watcher) {
      return;
    }
    watcher.stopped = true;
    if (watcher.timer) {
      cancelTimeout(watcher.timer);
      watcher.timer = null;
    }
  },
};

// ── 后端这一端 ──

// 通道是否在为这个进程监听：就绪标记由环境浏览器自己写入，pid 要对得上，且写入时间不早于这次启动
// （防止上次运行留下的标记碰上被复用的 pid）。
export async function quitChannelReady(controlDir, envId, pid, launchedAt = 0) {
  let info = null;
  try {
    info = await IOUtils.readJSON(controlFiles(controlDir).ready);
  } catch {
    return false;
  }
  return (
    !!info &&
    info.version === VERSION &&
    info.envId === envId &&
    Number(info.pid) === Number(pid) &&
    Number(info.startedAt) >= Number(launchedAt || 0)
  );
}

export async function requestQuit(controlDir, envId, pid) {
  const { request } = controlFiles(controlDir);
  await IOUtils.writeJSON(
    request,
    { version: VERSION, envId, pid: Number(pid), requestedAt: new Date().toISOString() },
    { tmpPath: request + ".tmp" }
  );
}

export async function quitRequestPending(controlDir) {
  return IOUtils.exists(controlFiles(controlDir).request);
}

// 撤回还没被取走的请求。返回 false 表示文件已经不在：环境恰好在撤回前一刻取走了它，应按已接收处理。
export async function withdrawQuitRequest(controlDir) {
  try {
    await IOUtils.remove(controlFiles(controlDir).request, { ignoreAbsent: false });
    return true;
  } catch {
    return false;
  }
}
