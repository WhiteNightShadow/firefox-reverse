/* EnvironmentBackend.sys.mjs
 *
 * Environment-level browser isolation:
 *   one environment = one profile directory + one Firefox process.
 *
 * Data lives outside any Firefox profile, under:
 *   ~/.firefox-reverse/environments
 *
 * 这里是对外入口（UI、Agent 工具、MCP 都调它）：环境的创建、配置、打开/关闭/删除，以及这些操作
 * 之间的加锁和运行状态。具体实现按职责拆在：
 *   EnvironmentStore           目录布局、manifest/env.json 读写与锁
 *   EnvironmentProcess         进程启动、Marionette、pid 身份核对与终止
 *   EnvironmentFingerprint     指纹生成、校验与采集
 *   EnvironmentPrefs           指纹/代理 → user.js
 *   EnvironmentCurrentProcess  主浏览器自己的指纹配置
 */

import { NATIVE_CONSISTENCY_MODE, isNativeFingerprint } from "./NativeFingerprintPolicy.sys.mjs";
import {
  DEFAULT_PORT_BASE,
  MAX_PORT_SCAN,
  PROCESS_ALIVE,
  PROCESS_DEAD,
  PROCESS_UNKNOWN,
  SCHEMA_VERSION,
  currentEnvId,
  currentMarionettePort,
  delay,
  envDisplayName,
  isRuntimeActive,
  nowISO,
  processLabelFor,
  randHex,
  shortEnv,
  timestampId,
} from "./EnvironmentCommon.sys.mjs";
import {
  browserFamilyFromFingerprint,
  buildFingerprint,
  captureCurrentBrowser,
  defaultFingerprint,
  fingerprintFromCapture,
  firefoxGenerateOptions,
  validateFingerprint,
} from "./EnvironmentFingerprint.sys.mjs";
import { defaultProxy, engineFingerprintFor, fingerprintUserPrefs, profileUserJs } from "./EnvironmentPrefs.sys.mjs";
import { EnvironmentStore } from "./EnvironmentStore.sys.mjs";
import { EnvironmentProcesses } from "./EnvironmentProcess.sys.mjs";
import { CurrentProcessConfig } from "./EnvironmentCurrentProcess.sys.mjs";

const FIREFOX_ONLY_POLICY = "firefox-only-v1";

export class EnvironmentBackend {
  constructor(opts = {}) {
    this._root = opts.root || EnvironmentStore.defaultRoot();
    this._store = new EnvironmentStore(this._root);
    this._processes = new EnvironmentProcesses(opts);
    this._currentProcess = new CurrentProcessConfig(this._store);
    this._closeWaitMs = Math.max(1, Number(opts.closeWaitMs) || 15000);
    this._reservedPorts = new Set();
  }

  get root() {
    return this._root;
  }

  // 自测和诊断脚本（scripts/verify-native-fingerprint.mjs）直接用到的内部入口，转到各自的模块。
  _loadEnv(id) {
    return this._store.loadEnv(id);
  }

  _saveEnv(env, opts) {
    return this._store.saveEnv(env, opts);
  }

  _saveRuntime(env) {
    return this._store.saveRuntime(env);
  }

  get _procs() {
    return this._processes.procs;
  }

  get _procOutputTails() {
    return this._processes.outputTails;
  }

  _pidState(...args) {
    return this._processes.pidState(...args);
  }

  _killPid(...args) {
    return this._processes.killPid(...args);
  }

  _fingerprintUserPrefs(fingerprint, resetNative) {
    return fingerprintUserPrefs(fingerprint, resetNative);
  }

  _profileUserJs(env, port, runtimeConfig) {
    return profileUserJs(env, env ? this._store.paths(env.id) : null, port, runtimeConfig);
  }

  _buildFingerprint(env, options, source) {
    return buildFingerprint(env, options, source);
  }

  _firefoxGenerateOptions(options) {
    return firefoxGenerateOptions(options);
  }

  async _stageEnvironmentConfig(env) {
    const runtimeConfig = await this._syncProfileRuntimeConfig(env);
    await this._writeProfilePrefs(env, env.runtime?.marionettePort || null, runtimeConfig);
  }

  async _writeProfilePrefs(env, port = null, runtimeConfig = null) {
    await IOUtils.makeDirectory(env.profilePath, { ignoreExisting: true, createAncestors: true });
    const config =
      runtimeConfig || {
        fingerprint: await this._store.readJSON(env.fingerprintPath, defaultFingerprint(env)),
        proxy: await this._store.readJSON(env.proxyPath, defaultProxy()),
      };
    await IOUtils.writeUTF8(this._store.paths(env.id).profileUserJsPath, profileUserJs(env, this._store.paths(env.id), port, config), {
      tmpPath: this._store.paths(env.id).profileUserJsPath + ".tmp",
    });
  }

  async _syncProfileRuntimeConfig(env) {
    const p = this._store.paths(env.id);
    await IOUtils.makeDirectory(p.profileFrxDir, { ignoreExisting: true, createAncestors: true });
    const fingerprint = await this._store.readJSON(env.fingerprintPath, null);
    if (!fingerprint || typeof fingerprint !== "object" || Array.isArray(fingerprint)) throw new Error("environment fingerprint configuration is missing or invalid");
    validateFingerprint(fingerprint);
    const engineFingerprint = engineFingerprintFor(fingerprint);
    const proxy = await this._store.readJSON(env.proxyPath, defaultProxy());
    await this._store.writeJSON(p.runtimeFingerprintPath, engineFingerprint);
    await this._store.writeJSON(p.runtimeProxyPath, proxy);
    return {
      fingerprintPath: p.runtimeFingerprintPath,
      proxyPath: p.runtimeProxyPath,
      fingerprint,
      engineFingerprint,
      proxy,
    };
  }

  async create({ id, name, generateOptions = null } = {}) {
    await this._store.ensureRoot();
    const finalName = String(name || "").trim() || "New Environment";
    if (generateOptions?.consistencyMode && ![NATIVE_CONSISTENCY_MODE, "legacy"].includes(generateOptions.consistencyMode)) throw new Error("unsupported fingerprint consistency mode");
    const envId = id ? String(id).trim() : this._store.newId(finalName);
    this._store.validateId(envId);
    const p = this._store.paths(envId);
    if (await IOUtils.exists(p.envPath)) {
      throw new Error("environment already exists: " + envId);
    }
    const ts = nowISO();
    const requestedOptions = {
      randomize: generateOptions?.randomize !== false,
      ...(generateOptions || {}),
    };
    const generationOptions = firefoxGenerateOptions(requestedOptions);
    const env = {
      schemaVersion: SCHEMA_VERSION,
      id: envId,
      name: finalName,
      browserFamily: "firefox",
      fingerprintPolicy: FIREFOX_ONLY_POLICY,
      consistencyMode: generateOptions?.consistencyMode || NATIVE_CONSISTENCY_MODE,
      nativeRenderingManaged: generateOptions?.consistencyMode !== "legacy",
      audioSeed: randHex(32),
      createdAt: ts,
      updatedAt: ts,
      rootPath: p.rootPath,
      profilePath: p.profilePath,
      fingerprintPath: p.fingerprintPath,
      proxyPath: p.proxyPath,
      traceDir: p.traceDir,
      controlDir: p.controlDir,
      capturesDir: p.capturesDir,
      logsDir: p.logsDir,
      seed: randHex(16),
      seedMode: "persistent",
      source: {
        type: generateOptions ? "generated" : "generated-default",
        browser: "firefox",
        createdAt: ts,
        options: generationOptions,
      },
      processLabel: null,
      runtime: {
        status: "stopped",
        pid: null,
        marionettePort: null,
        lastStartedAt: null,
        lastStoppedAt: null,
        lastUrl: null,
        processLabel: null,
      },
    };
    env.processLabel = processLabelFor(env);
    env.runtime.processLabel = env.processLabel;
    const fingerprint = buildFingerprint(
      env,
      generationOptions,
      { type: generateOptions ? "generated" : "generated-default" }
    );
    validateFingerprint(fingerprint);
    for (const dir of [p.rootPath, p.profilePath, p.traceDir, p.controlDir, p.capturesDir, p.logsDir]) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    await this._store.writeJSON(p.fingerprintPath, fingerprint);
    await this._store.writeJSON(p.proxyPath, defaultProxy());
    const runtimeConfig = await this._syncProfileRuntimeConfig(env);
    await this._writeProfilePrefs(env, null, runtimeConfig);
    await this._store.writeJSON(p.runtimePath, env.runtime);
    await this._store.saveEnv(env, { create: true });
    return { ok: true, environment: shortEnv(env) };
  }

  // 主浏览器（当前进程）自己的指纹/代理配置，实现见 EnvironmentCurrentProcess。
  currentProcess(args = {}) {
    return this._currentProcess.describe(args, async (id, refresh) => {
      const env = await this._store.loadEnv(id);
      return shortEnv(refresh === false ? env : await this._refreshRuntime(env));
    });
  }

  readCurrentProcessConfig(args = {}) {
    return this._currentProcess.read(args);
  }

  writeCurrentProcessConfig(args = {}) {
    return this._currentProcess.write(args);
  }

  generateCurrentProcessFingerprint(args = {}) {
    return this._currentProcess.generate(args);
  }

  importCurrentProcessFingerprint(args = {}) {
    return this._currentProcess.importCapture(args);
  }

  resetCurrentProcessDefault(args = {}) {
    return this._currentProcess.reset(args);
  }

  async current({ refresh = true } = {}) {
    await this._store.ensureRoot();
    const id = currentEnvId();
    if (!id) {
      return { ok: true, id: null, environment: null, root: this._root };
    }
    try {
      const env = refresh === false ? await this._store.loadEnv(id) : await this._refreshRuntime(await this._store.loadEnv(id));
      return { ok: true, id, environment: shortEnv(env), root: this._root };
    } catch (e) {
      return {
        ok: false,
        id,
        environment: null,
        root: this._root,
        error: e && e.message ? e.message : String(e),
      };
    }
  }

  // 会写环境目录的操作与打开、关闭、删除互斥：删除递归清目录时不能有人同时往里写文件。
  update(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._update(args));
  }

  async _update({ id, name } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    if (name != null) {
      const n = String(name).trim();
      if (!n) {
        throw new Error("name cannot be empty");
      }
      env.name = n;
    }
    env.processLabel = processLabelFor(env);
    env.runtime = {
      ...(env.runtime || {}),
      processLabel: env.processLabel,
    };
    await this._store.saveEnv(env);
    await this._writeProfilePrefs(env, env.runtime?.marionettePort || null);
    return { ok: true, environment: shortEnv(env) };
  }

  async _refreshRuntime(env) {
    const rt = env.runtime || {};
    const localProc = this._processes.procs.get(env.id);
    if (localProc && localProc.exitCode == null) {
      const localPid = localProc.pid || rt.pid || null;
      const readyNow =
        rt.status !== "closing" &&
        rt.marionetteReady !== true &&
        rt.marionettePort &&
        (await this._processes.isPortReady(rt.marionettePort));
      if (!isRuntimeActive(rt) || (localPid && Number(rt.pid) !== Number(localPid)) || readyNow) {
        env.runtime = {
          ...rt,
          status: rt.status === "closing" ? "closing" : "running",
          pid: localPid,
          stopReason: null,
          ...(readyNow
            ? {
                marionetteReady: true,
                marionetteStatus: "ready",
                marionetteReadyAt: nowISO(),
                startWarning: null,
              }
            : {}),
        };
        await this._store.saveRuntime(env);
      }
      return env;
    }
    if (isRuntimeActive(rt) && rt.pid) {
      const state = await this._processes.pidState(rt.pid, env.id, env);
      if (state === PROCESS_DEAD) {
        env.runtime = {
          ...rt,
          status: "stopped",
          pid: null,
          lastStoppedAt: nowISO(),
          stopReason: "process-not-found",
        };
        await this._store.saveRuntime(env);
      } else if (
        rt.status !== "closing" &&
        rt.marionetteReady !== true &&
        rt.marionettePort &&
        (await this._processes.isPortReady(rt.marionettePort))
      ) {
        env.runtime = {
          ...rt,
          status: "running",
          marionetteReady: true,
          marionetteStatus: "ready",
          marionetteReadyAt: nowISO(),
          startWarning: null,
        };
        await this._store.saveRuntime(env);
      }
    }
    return env;
  }

  async list({ refresh = true } = {}) {
    const manifest = await this._store.loadManifest();
    const out = [];
    const missing = [];
    for (const item of manifest.environments || []) {
      try {
        let env = await this._store.loadEnv(item.id);
        if (refresh) {
          env = await this._refreshRuntime(env);
        }
        out.push(shortEnv(env));
      } catch (e) {
        // 目录已经不在的索引项（并发删除留下的幽灵条目）：从索引里清掉，不再显示成删不掉的环境。
        if (/environment not found/.test(String(e?.message || ""))) {
          missing.push(item.id);
          continue;
        }
        out.push(item);
      }
    }
    if (missing.length) {
      await this._store.removeFromManifest(missing);
    }
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { ok: true, root: this._root, count: out.length, environments: out };
  }

  async status({ id } = {}) {
    if (id) {
      const env = await this._refreshRuntime(await this._store.loadEnv(String(id)));
      return { ok: true, environment: shortEnv(env) };
    }
    return this.list({ refresh: true });
  }

  async _usedPorts(exceptId = null) {
    const manifest = await this._store.loadManifest();
    const used = new Set([currentMarionettePort(), ...this._reservedPorts]);
    for (const item of manifest.environments || []) {
      if (item.id === exceptId) {
        continue;
      }
      const rt = item.runtime || {};
      const localProc = this._processes.procs.get(item.id);
      const localRunning = !!localProc && localProc.exitCode == null;
      if ((isRuntimeActive(rt) || localRunning) && rt.marionettePort) {
        used.add(Number(rt.marionettePort));
      }
    }
    return used;
  }

  async _allocatePort(env, requestedPort = null) {
    const used = await this._usedPorts(env.id);
    const current = Number(requestedPort || env.runtime?.marionettePort || 0);
    if (current && !used.has(current) && (await this._processes.isPortAvailable(current))) {
      return current;
    }
    const base = DEFAULT_PORT_BASE;
    for (let i = 0; i < MAX_PORT_SCAN; i++) {
      const port = base + i;
      if (!used.has(port) && (await this._processes.isPortAvailable(port))) {
        return port;
      }
    }
    throw new Error("no free Marionette port found");
  }

  async open({ id, url, port, firefoxBin } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    // 检查运行状态、分配端口、拉起进程放在同一把锁里：同一环境被并发打开时不会在同一个 profile 上起第二个实例。
    // 等 Marionette 就绪（最长 90 秒）在锁外进行，不挡住期间的关闭等操作。
    const launched = await this._store.withLock(`lifecycle:${id}`, () => this._spawn({ id: String(id), url, port, firefoxBin }));
    if (launched.alreadyRunning) {
      return launched.alreadyRunning;
    }
    return this._finishOpen(launched);
  }

  async _spawn({ id, url, port, firefoxBin }) {
    const env = await this._refreshRuntime(await this._store.loadEnv(id));
    if ((env.runtime.status === "running" || env.runtime.status === "starting" || env.runtime.status === "closing") && env.runtime.pid) {
      return { alreadyRunning: { ok: true, alreadyRunning: true, environment: shortEnv(env) } };
    }
    // 端口分配全局串行，分到即预留，直到带端口的运行状态落盘：两个环境同时打开不会分到同一个端口。
    const marionettePort = await this._store.withLock("ports", async () => {
      const chosen = await this._allocatePort(env, port);
      this._reservedPorts.add(chosen);
      return chosen;
    });
    try {
      return await this._spawnWithPort(env, marionettePort, { url, firefoxBin });
    } finally {
      this._reservedPorts.delete(marionettePort);
    }
  }

  async _spawnWithPort(env, marionettePort, { url, firefoxBin }) {
    const bin = firefoxBin || this._processes.getFirefoxBin();
    const runtimeConfig = await this._syncProfileRuntimeConfig(env);
    await this._writeProfilePrefs(env, marionettePort, runtimeConfig);
    const p = this._store.paths(env.id);
    const args = [
      "-marionette",
      "-remote-allow-system-access",
      "-no-remote",
      "-new-instance",
      "-profile",
      env.profilePath,
    ];
    const finalUrl = String(url || "").trim();
    if (finalUrl) {
      args.push(finalUrl);
    }
    const launch = this._processes.launchSpec(env, bin, args, marionettePort);
    env.runtime = {
      ...env.runtime,
      status: "starting",
      pid: null,
      marionettePort,
      marionetteReady: false,
      marionetteStatus: "starting",
      lastStartedAt: nowISO(),
      lastUrl: finalUrl || null,
      firefoxBin: bin,
      envName: envDisplayName(env),
      processLabel: launch.argv0,
      processArgv0: launch.argv0,
      startError: null,
      startWarning: null,
    };
    await this._store.saveRuntime(env);
    const Subprocess = this._processes.getSubprocess();
    if (!Subprocess) {
      throw new Error("Subprocess unavailable");
    }
    const childEnv = {
      MOZ_FRX_ENV_ID: env.id,
      MOZ_FRX_ENV_NAME: envDisplayName(env),
      MOZ_FRX_PROCESS_LABEL: launch.argv0,
      MOZ_FRX_ENVS_ROOT: this._root,
      MOZ_FRX_FINGERPRINT_CONFIG: runtimeConfig.fingerprintPath,
      // Subprocess null removes an inherited value; empty string is Invalid.
      MOZ_FRX_FINGERPRINT_JSON: isNativeFingerprint(runtimeConfig.engineFingerprint) ? null : JSON.stringify(runtimeConfig.engineFingerprint),
      MOZ_FRX_PARENT_CONFIG_TOKEN: null,
      MOZ_FRX_PROXY_CONFIG: runtimeConfig.proxyPath,
      // 没有任何代码读取它，却会把代理用户名/密码明文带进子进程环境；null 同时清掉继承值。
      MOZ_FRX_PROXY_JSON: null,
      MOZ_FRX_TRACE_DIR: env.traceDir,
      MOZ_FRX_CONTROL_DIR: env.controlDir,
      MOZ_WEBAPI_TRACE_FILE: PathUtils.join(env.traceDir, "webapi.ndjson"),
      MOZ_WEBAPI_TRACE_CTL: PathUtils.join(env.controlDir, "webapi.ctl"),
      MOZ_JSVMP_TRACE_FILE: PathUtils.join(env.traceDir, "jsvmp.ndjson"),
      MOZ_FRX_HIDE_REMOTE_CONTROL_CUE: "1",
      MOZ_MARIONETTE: "1",
      MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS: JSON.stringify({ "marionette.port": marionettePort }),
      FRX_ENV_ID: env.id,
      FRX_ENV_NAME: envDisplayName(env),
      FRX_ENVS_ROOT: this._root,
    };
    let proc;
    try {
      proc = await Subprocess.call({
        command: launch.command,
        arguments: launch.arguments,
        environment: childEnv,
        environmentAppend: true,
        stderr: "stdout",
      });
    } catch (e) {
      env.runtime = {
        ...env.runtime,
        status: "stopped",
        pid: null,
        marionetteReady: false,
        marionetteStatus: "launch-error",
        lastStoppedAt: nowISO(),
        stopReason: "launch-error",
        startError: e && e.message ? e.message : String(e),
      };
      await this._store.saveRuntime(env);
      throw e;
    }
    this._processes.procs.set(env.id, proc);
    this._processes.startOutputDrain(env.id, proc);
    env.runtime = {
      ...env.runtime,
      status: "starting",
      pid: proc && proc.pid ? proc.pid : null,
      marionettePort,
      lastStartedAt: env.runtime.lastStartedAt,
      lastUrl: finalUrl || null,
      firefoxBin: bin,
      envName: envDisplayName(env),
      processLabel: launch.argv0,
      processArgv0: launch.argv0,
    };
    await this._store.saveRuntime(env);
    return { env, proc, marionettePort, launch, childEnv };
  }

  async _finishOpen({ env, proc, marionettePort, launch, childEnv }) {
    const startup = await this._processes.waitForMarionette(proc, marionettePort);
    if (startup.exited) {
      const output = String(this._processes.outputTails.get(env.id) || "").trim();
      env.runtime = {
        ...env.runtime,
        status: "stopped",
        pid: null,
        marionetteReady: false,
        marionetteStatus: "process-exited",
        startupDurationMs: startup.durationMs,
        lastStoppedAt: nowISO(),
        stopReason: "process-exited-before-marionette",
        startError: output || "Firefox exited before Marionette became ready",
      };
      await this._store.saveRuntime(env);
      this._processes.procs.delete(env.id);
      throw new Error(env.runtime.startError);
    }
    const startWarning = startup.ready
      ? null
      : `Firefox is running, but Marionette :${marionettePort} was not ready within ${Math.ceil(this._processes.startupTimeoutMs / 1000)}s`;
    env.runtime = {
      ...env.runtime,
      status: "running",
      marionetteReady: startup.ready,
      marionetteStatus: startup.ready ? "ready" : "timeout",
      marionetteReadyAt: startup.ready ? nowISO() : null,
      startupDurationMs: startup.durationMs,
      startWarning,
    };
    await this._store.saveRuntime(env);
    return {
      ok: true,
      launched: true,
      marionetteReady: startup.ready,
      startupDurationMs: startup.durationMs,
      warning: startWarning,
      command: launch.command,
      args: launch.arguments,
      originalCommand: launch.originalCommand,
      originalArgs: launch.originalArgs,
      argv0: launch.argv0,
      // 结果会进入工具输出和会话记录：只回显实际设置的变量，null（删除继承值）不回显。
      launchEnvironment: Object.fromEntries(Object.entries(childEnv).filter(([, value]) => value != null)),
      environment: shortEnv(env),
    };
  }

  async close({ id } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    return this._store.withLock(`lifecycle:${id}`, () => this._close(String(id)));
  }

  async _close(id) {
    const env = await this._store.loadEnv(id);
    const rt = env.runtime || {};
    const proc = this._processes.procs.get(env.id);
    const local = !!proc && proc.exitCode == null;
    const pid = (local && proc.pid) || rt.pid || null;
    const stopped = stopReason => {
      env.runtime = {
        ...(env.runtime || {}),
        status: "stopped",
        pid: null,
        lastStoppedAt: nowISO(),
        stopReason,
        marionetteReady: false,
        marionetteStatus: "stopped",
      };
    };
    // 记录的 pid 已不属于这个环境（已退出，或重启后被别的程序复用）：一个信号都不发，直接记为已停止。
    const identity = local ? PROCESS_ALIVE : pid ? await this._processes.pidState(pid, env.id, env, { strict: true }) : PROCESS_DEAD;
    if (identity === PROCESS_DEAD) {
      this._processes.forget(env.id);
      stopped("process-not-found");
      await this._store.saveRuntime(env);
      return { ok: true, environment: shortEnv(env) };
    }
    env.runtime = { ...rt, status: "closing", lastClosingAt: nowISO() };
    await this._store.saveRuntime(env);
    const gone = async () => (local ? proc.exitCode != null : (await this._processes.pidState(pid, env.id, env)) === PROCESS_DEAD);
    const waitGone = async ms => {
      for (const until = Date.now() + ms; Date.now() < until; await delay(250)) {
        if (await gone()) {
          return true;
        }
      }
      return gone();
    };
    // ① 先请浏览器自己退出：正常落盘 cookie/localStorage/会话，刚登录就关也不会丢登录态。
    let reason = "closed";
    let exited = !!rt.marionettePort && (await this._processes.quitViaMarionette(rt.marionettePort, env)) && (await waitGone(this._closeWaitMs));
    // ② 退不掉再发终止信号，等不到才强杀。认不出这个 pid 是不是本环境时（查不了进程命令行）一个信号都不发。
    if (!exited && identity === PROCESS_UNKNOWN) {
      env.runtime = { ...(env.runtime || {}), status: "running", stopReason: "close-failed", lastCloseFailedAt: nowISO() };
      await this._store.saveRuntime(env);
      return { ok: false, error: "无法确认该进程属于这个环境，没有发送终止信号；请手动结束该进程后重试。", environment: shortEnv(env) };
    }
    if (!exited) {
      reason = "terminated";
      if (local && proc.kill) {
        try {
          proc.kill();
        } catch {
          /* process may already be gone */
        }
        exited = await waitGone(this._closeWaitMs);
        if (!exited && pid && (await this._processes.killPid(pid, { force: true }))) {
          reason = "forced-kill-after-timeout";
          exited = await waitGone(5000);
        }
      } else {
        const res = await this._processes.terminatePid(pid, env);
        exited = res.ok;
        if (res.forced) {
          reason = "forced-kill-after-timeout";
        }
      }
    }
    if (!exited) {
      // 进程还在：不能记成已停止，否则下次打开会在仍被占用的 profile 上再起一个实例。
      env.runtime = { ...(env.runtime || {}), status: "running", stopReason: "close-failed", lastCloseFailedAt: nowISO() };
      await this._store.saveRuntime(env);
      return { ok: false, error: "环境进程没有退出，已保持运行状态；请稍后重试或手动结束该进程。", environment: shortEnv(env) };
    }
    this._processes.forget(env.id);
    stopped(reason);
    await this._store.saveRuntime(env);
    return { ok: true, environment: shortEnv(env) };
  }

  async delete({ id, confirm = false } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    if (confirm !== true) {
      throw new Error("confirm:true required to delete an environment");
    }
    // 与打开、关闭互斥；删目录时再持有环境写锁，进行中的写入要么先完成再被删掉，要么在删除后失败。
    return this._store.withLock(`lifecycle:${id}`, async () => {
      const env = await this._refreshRuntime(await this._store.loadEnv(String(id)));
      if (env.runtime?.status === "running" || env.runtime?.status === "starting" || env.runtime?.status === "closing") {
        throw new Error("environment is running; close it before delete");
      }
      // 只删按 root + id 推导出的目录：env.json 里存的绝对路径可能来自迁移前的位置，不能据此递归删除。
      await this._store.withLock(`env:${env.id}`, () => IOUtils.remove(this._store.paths(env.id).rootPath, { recursive: true, ignoreAbsent: true }));
      await this._store.removeFromManifest(env.id);
      this._processes.forget(env.id);
      return { ok: true, deleted: env.id };
    });
  }

  _configPath(env, type) {
    const t = String(type || "fingerprint").toLowerCase();
    if (t === "fingerprint") {
      return env.fingerprintPath;
    }
    if (t === "proxy") {
      return env.proxyPath;
    }
    throw new Error("unsupported config type: " + type);
  }

  async readConfig({ id, type = "fingerprint" } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    const path = this._configPath(env, type);
    const config = await this._store.readJSON(path, null);
    if (!config || typeof config !== "object") {
      throw new Error(`cannot read ${type} config for environment ${id}`);
    }
    return { ok: true, id: env.id, type, path, config };
  }

  writeConfig(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._writeConfig(args));
  }

  async _writeConfig({ id, type = "fingerprint", config, text } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("config must be a JSON object");
    }
    const configType = String(type || "fingerprint").toLowerCase();
    if (configType === "fingerprint" && isNativeFingerprint(await this._store.readJSON(env.fingerprintPath, null))) env.nativeRenderingManaged = true;
    const configBrowser = configType === "fingerprint" ? browserFamilyFromFingerprint(data) : "firefox";
    if (env.fingerprintPolicy === FIREFOX_ONLY_POLICY && configBrowser !== "firefox" && configBrowser !== "unknown") {
      throw new Error("this environment only accepts Firefox fingerprint configuration");
    }
    if (!data.schemaVersion) {
      data.schemaVersion = SCHEMA_VERSION;
    }
    if (configType === "fingerprint") validateFingerprint(data);
    data.updatedAt = nowISO();
    const path = this._configPath(env, type);
    await this._store.writeJSON(path, data);
    if (configType === "fingerprint") env.consistencyMode = isNativeFingerprint(data) ? NATIVE_CONSISTENCY_MODE : "legacy";
    if (configType === "fingerprint" && isNativeFingerprint(data)) env.nativeRenderingManaged = true;
    env.updatedAt = nowISO();
    await this._store.saveEnv(env);
    await this._stageEnvironmentConfig(env);
    return { ok: true, id: env.id, type, path, config: data, environment: shortEnv(env) };
  }

  _importPayload({ text, config } = {}) {
    let data = config;
    if (text != null) {
      data = JSON.parse(String(text));
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("environment import JSON must be an object");
    }
    const envMeta =
      data.env && typeof data.env === "object" && !Array.isArray(data.env)
        ? data.env
        : data.environment && typeof data.environment === "object" && !Array.isArray(data.environment)
          ? data.environment
          : {};
    const fingerprint =
      data.fingerprint && typeof data.fingerprint === "object" && !Array.isArray(data.fingerprint)
        ? data.fingerprint
        : data.fingerprintJson && typeof data.fingerprintJson === "object" && !Array.isArray(data.fingerprintJson)
          ? data.fingerprintJson
          : null;
    const proxy =
      data.proxy && typeof data.proxy === "object" && !Array.isArray(data.proxy)
        ? data.proxy
        : data.proxyJson && typeof data.proxyJson === "object" && !Array.isArray(data.proxyJson)
          ? data.proxyJson
          : null;
    const generateOptions =
      data.generateOptions && typeof data.generateOptions === "object" && !Array.isArray(data.generateOptions)
        ? data.generateOptions
        : null;
    return { data, envMeta, fingerprint, proxy, generateOptions };
  }

  importEnvironment(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._importEnvironment(args));
  }

  async _importEnvironment({ id, name, text, config, overwrite = false } = {}) {
    await this._store.ensureRoot();
    const payload = this._importPayload({ text, config });
    const finalName = String(name || payload.data.name || payload.envMeta.name || "Imported Environment").trim();
    const rawId = id || payload.data.id || payload.envMeta.id || "";
    const envId = rawId ? String(rawId).trim() : this._store.newId(finalName);
    this._store.validateId(envId);
    const p = this._store.paths(envId);
    const exists = await IOUtils.exists(p.envPath);
    if (exists && overwrite !== true) {
      throw new Error("environment already exists; pass overwrite:true to replace its configs");
    }
    const importedBrowser = payload.fingerprint ? browserFamilyFromFingerprint(payload.fingerprint) : "firefox";
    if (!exists && payload.fingerprint && importedBrowser !== "firefox") {
      throw new Error("new environments only accept Firefox fingerprint JSON; Chrome-like imports are no longer supported");
    }
    if (payload.fingerprint) validateFingerprint(payload.fingerprint);

    let env;
    if (!exists) {
      await this.create({
        id: envId,
        name: finalName,
        generateOptions: payload.generateOptions || { randomize: true },
      });
      env = await this._store.loadEnv(envId);
    } else {
      env = await this._store.loadEnv(envId);
      if (finalName) {
        env.name = finalName;
      }
    }
    if (
      exists &&
      env.fingerprintPolicy === FIREFOX_ONLY_POLICY &&
      payload.fingerprint &&
      importedBrowser !== "firefox" &&
      importedBrowser !== "unknown"
    ) {
      throw new Error("this environment only accepts Firefox fingerprint configuration");
    }

    const ts = nowISO();
    if (payload.fingerprint) {
      payload.fingerprint.schemaVersion = payload.fingerprint.schemaVersion || SCHEMA_VERSION;
      payload.fingerprint.updatedAt = ts;
      await this._store.writeJSON(env.fingerprintPath, payload.fingerprint);
      env.consistencyMode = isNativeFingerprint(payload.fingerprint) ? NATIVE_CONSISTENCY_MODE : "legacy";
      if (isNativeFingerprint(payload.fingerprint)) env.nativeRenderingManaged = true;
      env.browserFamily = exists
        ? payload.fingerprint.source?.browser || payload.fingerprint.source?.normalizedBrowser || env.browserFamily || "firefox"
        : "firefox";
    }
    if (payload.proxy) {
      payload.proxy.schemaVersion = payload.proxy.schemaVersion || SCHEMA_VERSION;
      payload.proxy.updatedAt = ts;
      await this._store.writeJSON(env.proxyPath, payload.proxy);
    }
    env.updatedAt = ts;
    env.source = {
      ...(env.source || {}),
      type: "imported",
      importedAt: ts,
      hasFingerprint: !!payload.fingerprint,
      hasProxy: !!payload.proxy,
    };
    await this._store.saveEnv(env, { create: true });
    const running = isRuntimeActive(env.runtime);
    await this._stageEnvironmentConfig(env);
    return {
      ok: true,
      id: env.id,
      imported: true,
      created: !exists,
      overwritten: exists && overwrite === true,
      needsRestart: running,
      environment: shortEnv(env),
      fingerprintPath: env.fingerprintPath,
      proxyPath: env.proxyPath,
    };
  }

  generateFingerprint(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._generateFingerprint(args));
  }

  async _generateFingerprint({ id, options = {} } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    const generationOptions = firefoxGenerateOptions(options);
    const previous = await this._store.readJSON(env.fingerprintPath, null);
    generationOptions.consistencyMode = options.consistencyMode || (isNativeFingerprint(previous) ? NATIVE_CONSISTENCY_MODE : "legacy");
    const fingerprint = buildFingerprint(env, generationOptions, { type: "generated" });
    env.consistencyMode = generationOptions.consistencyMode;
    if (isNativeFingerprint(fingerprint)) env.nativeRenderingManaged = true;
    await this._store.writeJSON(env.fingerprintPath, fingerprint);
    env.browserFamily = "firefox";
    env.source = { type: "generated", browser: "firefox", updatedAt: nowISO(), options: generationOptions };
    await this._store.saveEnv(env);
    await this._stageEnvironmentConfig(env);
    return { ok: true, id: env.id, path: env.fingerprintPath, fingerprint, environment: shortEnv(env) };
  }

  captureFingerprint(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._captureFingerprint(args));
  }

  async _captureFingerprint({ id } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    const capture = captureCurrentBrowser();
    const p = this._store.paths(env.id);
    await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
    const capturePath = PathUtils.join(p.capturesDir, `capture_${timestampId()}_${randHex(3)}.json`);
    await this._store.writeJSON(capturePath, capture);
    return { ok: true, id: env.id, path: capturePath, capture };
  }

  async _latestCapturePath(env) {
    const p = this._store.paths(env.id);
    let children = [];
    try {
      children = await IOUtils.getChildren(p.capturesDir);
    } catch {
      return "";
    }
    const captures = (children || []).filter(x => String(x).endsWith(".json")).sort();
    return captures.length ? captures[captures.length - 1] : "";
  }

  importFingerprint(args = {}) {
    return this._store.withLock(`lifecycle:${args.id}`, () => this._importFingerprint(args));
  }

  async _importFingerprint({ id, capturePath, capture, text } = {}) {
    if (!id) {
      throw new Error("id required");
    }
    const env = await this._store.loadEnv(String(id));
    const previous = await this._store.readJSON(env.fingerprintPath, null);
    env.consistencyMode = isNativeFingerprint(previous) ? NATIVE_CONSISTENCY_MODE : "legacy";
    if (isNativeFingerprint(previous)) env.nativeRenderingManaged = true;
    let finalCapture = capture || null;
    if (!finalCapture && text != null) {
      finalCapture = JSON.parse(String(text));
      if (typeof finalCapture === "string") {
        finalCapture = JSON.parse(finalCapture);
      }
    }
    let finalPath = String(capturePath || "");
    if (!finalCapture) {
      if (!finalPath) {
        finalPath = await this._latestCapturePath(env);
      } else if (!finalPath.includes("/") && !finalPath.includes("\\")) {
        finalPath = PathUtils.join(this._store.paths(env.id).capturesDir, finalPath);
      }
      if (!finalPath) {
        throw new Error("no capture found to import");
      }
      finalCapture = await this._store.readJSON(finalPath, null);
    }
    if (!finalCapture || typeof finalCapture !== "object") {
      throw new Error("capture must be a JSON object");
    }
    if (!finalPath) {
      const p = this._store.paths(env.id);
      await IOUtils.makeDirectory(p.capturesDir, { ignoreExisting: true, createAncestors: true });
      finalPath = PathUtils.join(p.capturesDir, `capture_pasted_${timestampId()}_${randHex(3)}.json`);
      await this._store.writeJSON(finalPath, finalCapture);
    }
    const fingerprint = fingerprintFromCapture(env, finalCapture, {
      type: "imported-capture",
      path: finalPath || null,
    });
    validateFingerprint(fingerprint);
    await this._store.writeJSON(env.fingerprintPath, fingerprint);
    env.browserFamily = "firefox";
    env.source = {
      type: "imported-capture",
      browser: env.browserFamily,
      updatedAt: nowISO(),
      capturePath: finalPath || null,
      capturedBrowser: fingerprint.source?.capturedBrowser || null,
      normalizedBrowser: fingerprint.source?.normalizedBrowser || null,
      normalizedFromNonFirefox: fingerprint.source?.normalizedFromNonFirefox === true,
    };
    await this._store.saveEnv(env);
    await this._stageEnvironmentConfig(env);
    return { ok: true, id: env.id, path: env.fingerprintPath, capturePath: finalPath || null, fingerprint, environment: shortEnv(env) };
  }
}
