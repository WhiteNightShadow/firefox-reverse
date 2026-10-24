/* EnvironmentProcess.sys.mjs — 环境浏览器进程：启动参数、Marionette 端口探测与就绪等待、经 Marionette
 * 请求正常退出、按命令行核对 pid 身份、发终止信号。 */

import {
  PROCESS_ALIVE,
  PROCESS_DEAD,
  PROCESS_UNKNOWN,
  cancelTimeout,
  delay,
  lazyESM,
  processLabelFor,
  processSlotLabel,
  safe,
  scheduleTimeout,
} from "./EnvironmentCommon.sys.mjs";

const DEFAULT_STARTUP_TIMEOUT_MS = 90000;
const DEFAULT_STARTUP_POLL_MS = 500;
const PROCESS_OUTPUT_TAIL_CHARS = 8192;

// 经环境自己的 Marionette 端口请求正常退出：浏览器会先落盘 cookie/localStorage/会话再退出，
// 避免刚登录就关窗导致登录态丢失。帧格式 `<字节数>:<JSON>`。退出前核对会话的 moz:profile：
// 记录过期、端口已被别的浏览器占用时不能让别人的浏览器退出。外部自动化正占着会话时 NewSession
// 会失败。这些情况都返回 false，由调用方退回信号终止。
export async function marionetteQuit(port, { profileSuffix = "", timeoutMs = 5000 } = {}) {
  const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
  const transport = sts.createTransport([], "127.0.0.1", port, null, null);
  const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
  const output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
  const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  reader.setInputStream(input);
  const writer = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
  writer.setOutputStream(output);
  const thread = Services.tm.currentThread;
  let pending = [];
  const readMore = () =>
    new Promise((resolve, reject) => {
      input.asyncWait(
        {
          onInputStreamReady(stream) {
            try {
              const available = stream.available();
              if (!available) {
                reject(new Error("marionette connection closed"));
                return;
              }
              pending = pending.concat(reader.readByteArray(available));
              resolve();
            } catch (e) {
              reject(e);
            }
          },
        },
        0,
        0,
        thread
      );
    });
  const readFrame = async () => {
    for (;;) {
      const colon = pending.indexOf(0x3a);
      if (colon > 0) {
        const length = Number(String.fromCharCode(...pending.slice(0, colon)));
        if (pending.length >= colon + 1 + length) {
          const body = new TextDecoder().decode(new Uint8Array(pending.slice(colon + 1, colon + 1 + length)));
          pending = pending.slice(colon + 1 + length);
          return JSON.parse(body);
        }
      }
      await readMore();
    }
  };
  let nextId = 0;
  const command = async (name, params) => {
    const id = ++nextId;
    const body = new TextEncoder().encode(JSON.stringify([0, id, name, params]));
    await new Promise(resolve => output.asyncWait({ onOutputStreamReady: () => resolve() }, 0, 0, thread));
    writer.writeByteArray([...new TextEncoder().encode(body.length + ":"), ...body]);
    for (;;) {
      const message = await readFrame();
      if (Array.isArray(message) && message[0] === 1 && message[1] === id) {
        if (message[2]) {
          throw new Error(`${name}: ${message[2].error || "failed"}`);
        }
        return message[3];
      }
    }
  };
  const job = (async () => {
    await readFrame();
    const session = await command("WebDriver:NewSession", {});
    const profile = String(session?.capabilities?.["moz:profile"] || "").replace(/\\/g, "/").toLowerCase();
    if (profileSuffix && !profile.endsWith(profileSuffix.toLowerCase())) {
      await command("WebDriver:DeleteSession", {}).catch(() => {});
      throw new Error("marionette port belongs to another browser");
    }
    try {
      await command("Marionette:Quit", { flags: ["eForceQuit"] });
    } catch (e) {
      // 退出请求已发出、应答前连接就断了：浏览器已经在退出，不能再当失败去补发终止信号。
      if (!/connection closed|NS_BASE_STREAM_CLOSED/.test(String(e?.message || e))) {
        throw e;
      }
    }
  })();
  job.catch(() => {});
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = scheduleTimeout(() => reject(new Error("marionette quit timed out")), timeoutMs);
  });
  try {
    await Promise.race([job, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    cancelTimeout(timer);
    for (const stream of [input, output]) {
      try {
        stream.close();
      } catch {
        /* already closed */
      }
    }
    try {
      transport.close(Cr.NS_OK);
    } catch {
      /* already closed */
    }
  }
}

export class EnvironmentProcesses {
  constructor(opts = {}) {
    this._firefoxBin = opts.firefoxBin || "";
    this._subprocess = opts.subprocess || null;
    this._portProbe = typeof opts.portProbe === "function" ? opts.portProbe : null;
    this._portReadyProbe = typeof opts.portReadyProbe === "function" ? opts.portReadyProbe : null;
    this._marionetteQuit = typeof opts.marionetteQuit === "function" ? opts.marionetteQuit : null;
    this.startupTimeoutMs = Math.max(1, Number(opts.startupTimeoutMs) || DEFAULT_STARTUP_TIMEOUT_MS);
    this._startupPollMs = Math.max(1, Number(opts.startupPollMs) || DEFAULT_STARTUP_POLL_MS);
    this._systemCommands = new Map();
    // 本浏览器会话里拉起的环境进程句柄（环境 id → Subprocess 进程）和它们最近的输出。
    this.procs = new Map();
    this._drains = new Map();
    this.outputTails = new Map();
  }

  async isPortAvailable(port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return false;
    }
    if (this._portProbe) {
      try {
        return !!(await this._portProbe(n));
      } catch {
        return false;
      }
    }
    let socket = null;
    try {
      socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      const flags = Ci.nsIServerSocket.LoopbackOnly | Ci.nsIServerSocket.KeepWhenOffline;
      socket.initSpecialConnection(n, flags, -1);
      return true;
    } catch {
      return false;
    } finally {
      if (socket) {
        try {
          socket.close();
        } catch {
          /* socket was not bound */
        }
      }
    }
  }

  async isPortReady(port) {
    if (this._portReadyProbe) {
      try {
        return !!(await this._portReadyProbe(Number(port)));
      } catch {
        return false;
      }
    }
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return false;
    }
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      let input = null;
      let transport = null;
      const finish = ready => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          cancelTimeout(timer);
        }
        try {
          input?.close();
        } catch {
          /* already closed */
        }
        try {
          transport?.close(Cr.NS_BINDING_ABORTED);
        } catch {
          /* already closed */
        }
        resolve(ready);
      };
      timer = scheduleTimeout(() => finish(false), 750);
      try {
        const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
        transport = sts.createTransport([], "127.0.0.1", n, null, null);
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, 1);
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 1);
        input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
        const thread = Cc["@mozilla.org/thread-manager;1"].getService().currentThread;
        input.asyncWait(stream => {
          try {
            stream.available();
            finish(true);
          } catch {
            finish(false);
          }
        }, 0, 0, thread);
      } catch {
        finish(false);
      }
    });
  }

  async waitForMarionette(proc, port) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (await this.isPortReady(port)) {
        return { ready: true, exited: false, durationMs: Date.now() - startedAt };
      }
      if (proc && proc.exitCode != null) {
        return { ready: false, exited: true, durationMs: Date.now() - startedAt };
      }
      await delay(this._startupPollMs);
    }
    return { ready: false, exited: false, durationMs: Date.now() - startedAt };
  }

  startOutputDrain(envId, proc) {
    if (!proc?.stdout || typeof proc.stdout.readString !== "function") {
      return;
    }
    this.outputTails.delete(envId);
    const task = (async () => {
      let tail = "";
      try {
        for (let chunk; (chunk = await proc.stdout.readString()); ) {
          tail = (tail + chunk).slice(-PROCESS_OUTPUT_TAIL_CHARS);
          this.outputTails.set(envId, tail);
        }
      } catch (e) {
        tail = (tail + `\n[output drain error] ${(e && e.message) || String(e)}`).slice(-PROCESS_OUTPUT_TAIL_CHARS);
        this.outputTails.set(envId, tail);
      }
      return tail;
    })();
    this._drains.set(envId, task);
    void task.finally(() => {
      if (this._drains.get(envId) === task) {
        this._drains.delete(envId);
      }
    });
  }

  getFirefoxBin() {
    if (this._firefoxBin) {
      return this._firefoxBin;
    }
    const exe = safe(() => Services.dirsvc.get("XREExeF", Ci.nsIFile).path, "");
    if (exe) {
      return exe;
    }
    const gre = safe(() => Services.dirsvc.get("GreBinD", Ci.nsIFile).path, "");
    if (gre) {
      const name = safe(() => Services.appinfo.OS === "WINNT", false) ? "firefox.exe" : "firefox";
      return PathUtils.join(gre, name);
    }
    throw new Error("cannot locate current Firefox executable");
  }

  getSubprocess() {
    if (this._subprocess) {
      return this._subprocess;
    }
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    return SP && SP.Subprocess;
  }

  async resolveSystemCommand(name) {
    if (this._systemCommands.has(name)) {
      return this._systemCommands.get(name);
    }
    const Subprocess = this.getSubprocess();
    if (!Subprocess || typeof Subprocess.pathSearch !== "function") {
      throw new Error(`cannot resolve system command: ${name}`);
    }
    const path = await Subprocess.pathSearch(name);
    this._systemCommands.set(name, path);
    return path;
  }

  processArgv0(env, port = null) {
    return String(processSlotLabel(port) || processLabelFor(env) || env.id || "Firefox Reverse")
      .replace(/[\u0000/]+/g, " ")
      .trim()
      .slice(0, 80) || env.id;
  }

  launchSpec(env, bin, args, port = null) {
    const os = safe(() => Services.appinfo.OS, "");
    const argv0 = this.processArgv0(env, port);
    if (os === "Darwin") {
      return {
        command: "/bin/zsh",
        arguments: ["-lc", 'label="$1"; shift; exec -a "$label" "$@"', "frx-env-launch", argv0, bin, ...args],
        originalCommand: bin,
        originalArgs: args,
        argv0,
      };
    }
    return {
      command: bin,
      arguments: args,
      originalCommand: bin,
      originalArgs: args,
      argv0,
    };
  }

  async quitViaMarionette(port, env) {
    const options = { profileSuffix: `/${env.id}/profile` };
    try {
      return this._marionetteQuit ? !!(await this._marionetteQuit(Number(port), options)) : await marionetteQuit(Number(port), options);
    } catch {
      return false;
    }
  }

  forget(envId) {
    this.procs.delete(envId);
    this._drains.delete(envId);
    this.outputTails.delete(envId);
  }

  async readProcessOutput(proc) {
    if (!proc || !proc.stdout || typeof proc.stdout.readString !== "function") {
      return "";
    }
    let output = "";
    for (let chunk; (chunk = await proc.stdout.readString()); ) {
      output += chunk;
    }
    return output;
  }

  // PID 会被系统复用：env.json 里记下的 pid 在浏览器或系统重启后可能已属于别的程序。传入 env 时
  // 同时核对身份——Unix 看命令行里是否有该环境的 profile；Windows 看映像名是否是 Firefox，strict
  // 时（要发终止信号前）再查命令行，因为 Firefox 自己就有很多 firefox.exe 子进程——
  // 对不上就当该环境已退出，后续也不会向这个 pid 发任何信号。
  async pidState(pid, envId = null, env = null, { strict = false } = {}) {
    if (!pid) {
      return PROCESS_DEAD;
    }
    if (envId) {
      const localProc = this.procs.get(envId);
      if (localProc && (!localProc.pid || Number(localProc.pid) === Number(pid))) {
        return localProc.exitCode == null ? PROCESS_ALIVE : PROCESS_DEAD;
      }
    }
    const os = safe(() => Services.appinfo.OS, "");
    const Subprocess = this.getSubprocess();
    if (!Subprocess) {
      return PROCESS_UNKNOWN;
    }
    try {
      let proc;
      if (os === "WINNT") {
        const tasklist = await this.resolveSystemCommand("tasklist.exe");
        proc = await Subprocess.call({
          command: tasklist,
          arguments: ["/FI", "PID eq " + String(pid), "/FO", "CSV", "/NH"],
          stderr: "stdout",
        });
        const out = await this.readProcessOutput(proc);
        const r = await proc.wait();
        if (r.exitCode !== 0) {
          return PROCESS_UNKNOWN;
        }
        for (const line of String(out).split(/\r?\n/)) {
          const match = line.match(/^"([^"]*)","(\d+)"/);
          if (match && Number(match[2]) === Number(pid)) {
            if (!env || !strict) {
              return env && !this.isEnvImage(match[1], env) ? PROCESS_DEAD : PROCESS_ALIVE;
            }
            if (!this.isEnvImage(match[1], env)) {
              return PROCESS_DEAD;
            }
            const command = await this.windowsProcessCommand(pid);
            return command === null ? PROCESS_UNKNOWN : this.commandMatchesEnv(command, env) ? PROCESS_ALIVE : PROCESS_DEAD;
          }
        }
        return PROCESS_DEAD;
      }
      if (env) {
        const command = await this.unixProcessCommand(pid);
        if (command !== null) {
          return command && this.commandMatchesEnv(command, env) ? PROCESS_ALIVE : PROCESS_DEAD;
        }
      }
      proc = await Subprocess.call({
        command: await this.unixCommand("kill"),
        arguments: ["-0", String(pid)],
        stderr: "stdout",
      });
      const r = await proc.wait();
      return r.exitCode === 0 ? PROCESS_ALIVE : PROCESS_DEAD;
    } catch {
      return PROCESS_UNKNOWN;
    }
  }

  // 优先用系统目录里的 ps/kill，不经 PATH 查找（避免被同名程序顶替）；都没有时才按 PATH 找。
  async unixCommand(name) {
    if (this._systemCommands.has(name)) {
      return this._systemCommands.get(name);
    }
    for (const dir of ["/bin", "/usr/bin"]) {
      const candidate = `${dir}/${name}`;
      if (await IOUtils.exists(candidate).catch(() => false)) {
        this._systemCommands.set(name, candidate);
        return candidate;
      }
    }
    try {
      return await this.resolveSystemCommand(name);
    } catch {
      return `/bin/${name}`;
    }
  }

  // 返回 pid 的完整命令行；进程不存在返回 ""；ps 不可用返回 null（退回只判断存活）。
  async unixProcessCommand(pid) {
    try {
      const proc = await this.getSubprocess().call({
        command: await this.unixCommand("ps"),
        arguments: ["-ww", "-o", "command=", "-p", String(pid)],
        stderr: "stdout",
      });
      const out = await this.readProcessOutput(proc);
      const r = await proc.wait();
      return r.exitCode === 0 ? String(out) : "";
    } catch {
      return null;
    }
  }

  // Windows 上查进程命令行（PowerShell / CIM）；查不了返回 null，表示身份无法确认。
  async windowsProcessCommand(pid) {
    try {
      const proc = await this.getSubprocess().call({
        command: await this.resolveSystemCommand("powershell.exe"),
        arguments: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
        ],
        stderr: "stdout",
      });
      const out = await this.readProcessOutput(proc);
      const r = await proc.wait();
      return r.exitCode === 0 ? String(out) : null;
    } catch {
      return null;
    }
  }

  // 按命令行里的 "<环境 id>/profile" 核对：id 只含 ASCII（ENV_ID_RE），不受系统输出编码影响
  // （Windows 中文用户目录），后面必须紧跟分隔符或结尾，避免 profile2 之类的误配。
  commandMatchesEnv(command, env) {
    const flags = safe(() => Services.appinfo.OS, "") === "WINNT" ? "i" : "";
    return new RegExp(`[\\\\/]${env.id}[\\\\/]profile(?![^\\s"'\\\\/])`, flags).test(String(command));
  }

  isEnvImage(image, env) {
    const bin = env.runtime?.firefoxBin || this._firefoxBin || "firefox.exe";
    return String(image).toLowerCase() === String(bin).split(/[\\/]/).pop().toLowerCase();
  }

  async terminatePid(pid, env = null) {
    if (!pid) {
      return { ok: false, forced: false };
    }
    const signalled = await this.killPid(pid, { force: false });
    if (!signalled) {
      return { ok: false, forced: false };
    }
    for (let i = 0; i < 60; i++) {
      if ((await this.pidState(pid, null, env)) === PROCESS_DEAD) {
        return { ok: true, forced: false };
      }
      await delay(250);
    }
    const forced = await this.killPid(pid, { force: true });
    for (let i = 0; i < 20; i++) {
      if ((await this.pidState(pid, null, env)) === PROCESS_DEAD) {
        return { ok: true, forced };
      }
      await delay(250);
    }
    return { ok: false, forced };
  }

  async killPid(pid, { force = false } = {}) {
    const os = safe(() => Services.appinfo.OS, "");
    const Subprocess = this.getSubprocess();
    if (!Subprocess || !pid) {
      return false;
    }
    try {
      const command = os === "WINNT" ? await this.resolveSystemCommand("taskkill.exe") : await this.unixCommand("kill");
      const proc = await Subprocess.call(
        os === "WINNT"
          ? { command, arguments: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], stderr: "stdout" }
          : { command, arguments: [force ? "-KILL" : "-TERM", String(pid)], stderr: "stdout" }
      );
      const result = await proc.wait();
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
