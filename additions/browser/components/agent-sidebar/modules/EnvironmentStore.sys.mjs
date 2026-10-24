/* EnvironmentStore.sys.mjs — 环境数据的目录布局和读写。根目录下 manifest.json 是索引，每个环境一个目录
 * （env.json、指纹/代理配置、profile、control/runtime.json 等）。同一资源的读改写按 key 加锁串行。 */

import { SCHEMA_VERSION, nowISO, randHex, safe, shortEnv } from "./EnvironmentCommon.sys.mjs";

const DEFAULT_DIR_NAME = "environments";
const ENV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

export class EnvironmentStore {
  constructor(root) {
    this.root = root;
    this._locks = new Map();
  }

  static defaultRoot() {
    const envRoot = safe(() => Services.env.get("MOZ_FRX_ENVS_ROOT"), "") || safe(() => Services.env.get("FRX_ENVS_ROOT"), "");
    if (envRoot) {
      return envRoot;
    }
    const home =
      safe(() => Services.env.get("HOME"), "") ||
      safe(() => Services.env.get("USERPROFILE"), "") ||
      safe(() => PathUtils.homeDir, "");
    if (!home) {
      return "";
    }
    return PathUtils.join(home, ".firefox-reverse", DEFAULT_DIR_NAME);
  }

  // 同一浏览器进程内，把同一资源（manifest、单个环境、环境启停、端口分配）的读改写串行化，
  // 避免 UI、Agent 工具和 MCP 同时操作时互相覆盖。不同 key 之间可以嵌套，同一 key 不可重入。
  withLock(key, fn) {
    const previous = this._locks.get(key) || Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.catch(() => {});
    this._locks.set(key, tail);
    void tail.then(() => {
      if (this._locks.get(key) === tail) {
        this._locks.delete(key);
      }
    });
    return run;
  }

  hasIO() {
    return typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined";
  }

  assertIO() {
    if (!this.hasIO()) {
      throw new Error("EnvironmentBackend requires Firefox IOUtils/PathUtils");
    }
  }

  paths(id) {
    const rootPath = PathUtils.join(this.root, id);
    const profilePath = PathUtils.join(rootPath, "profile");
    const profileFrxDir = PathUtils.join(profilePath, "frx");
    const traceDir = PathUtils.join(rootPath, "traces");
    const controlDir = PathUtils.join(rootPath, "control");
    return {
      rootPath,
      envPath: PathUtils.join(rootPath, "env.json"),
      fingerprintPath: PathUtils.join(rootPath, "fingerprint.json"),
      proxyPath: PathUtils.join(rootPath, "proxy.json"),
      profilePath,
      profileFrxDir,
      runtimeFingerprintPath: PathUtils.join(profileFrxDir, "fingerprint.json"),
      runtimeProxyPath: PathUtils.join(profileFrxDir, "proxy.json"),
      profileUserJsPath: PathUtils.join(profilePath, "user.js"),
      traceDir,
      controlDir,
      capturesDir: PathUtils.join(rootPath, "captures"),
      logsDir: PathUtils.join(rootPath, "logs"),
      runtimePath: PathUtils.join(controlDir, "runtime.json"),
    };
  }

  manifestPath() {
    return PathUtils.join(this.root, "manifest.json");
  }

  async ensureRoot() {
    this.assertIO();
    if (!this.root) {
      throw new Error("environment root is empty");
    }
    await IOUtils.makeDirectory(this.root, { ignoreExisting: true, createAncestors: true });
    const manifestPath = this.manifestPath();
    if (!(await IOUtils.exists(manifestPath))) {
      await this.writeJSON(manifestPath, {
        schemaVersion: SCHEMA_VERSION,
        root: this.root,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        environments: [],
      });
    }
  }

  async readJSON(path, fallback = null) {
    try {
      return await IOUtils.readJSON(path);
    } catch {
      return fallback;
    }
  }

  async writeJSON(path, data) {
    const dir = PathUtils.parent(path);
    if (dir) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    await IOUtils.writeJSON(path, data, { tmpPath: path + ".tmp" });
  }

  async loadManifest() {
    await this.ensureRoot();
    const m = await this.readJSON(this.manifestPath(), null);
    if (!m || !Array.isArray(m.environments)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        root: this.root,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        environments: [],
      };
    }
    return m;
  }

  async saveManifest(manifest) {
    manifest.schemaVersion = SCHEMA_VERSION;
    manifest.root = this.root;
    manifest.updatedAt = nowISO();
    await this.writeJSON(this.manifestPath(), manifest);
  }

  async saveEnv(env, { create = false } = {}) {
    await this.withLock(`env:${env.id}`, () => this.writeEnv(env, { create }));
  }

  async writeEnv(env, { create = false } = {}) {
    // 环境已被并发删除时不能再写回来（writeJSON 会补建目录，留下只有 env.json 的僵尸环境）。
    if (!create && !(await IOUtils.exists(this.paths(env.id).envPath))) {
      throw new Error("environment not found: " + env.id);
    }
    env.updatedAt = nowISO();
    await this.writeJSON(this.paths(env.id).envPath, env);
    await this.upsertManifest(env);
  }

  async upsertManifest(env) {
    await this.withLock("manifest", async () => {
      const manifest = await this.loadManifest();
      const summary = shortEnv(env);
      const i = manifest.environments.findIndex(e => e.id === env.id);
      if (i >= 0) {
        manifest.environments[i] = summary;
      } else {
        manifest.environments.push(summary);
      }
      manifest.environments.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      await this.saveManifest(manifest);
    });
  }

  async removeFromManifest(ids) {
    const drop = new Set([].concat(ids));
    await this.withLock("manifest", async () => {
      const manifest = await this.loadManifest();
      manifest.environments = manifest.environments.filter(e => !drop.has(e.id));
      await this.saveManifest(manifest);
    });
  }

  validateId(id) {
    if (!ENV_ID_RE.test(String(id || ""))) {
      throw new Error("invalid env id: use letters, numbers, _ or -");
    }
  }

  newId(name) {
    const d = new Date();
    const stamp =
      d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") +
      "_" +
      String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0") +
      String(d.getSeconds()).padStart(2, "0");
    const slug = slugify(name);
    return "env_" + stamp + "_" + (slug ? slug + "_" : "") + randHex(4);
  }

  async loadEnv(id) {
    this.validateId(id);
    await this.ensureRoot();
    const env = await this.readJSON(this.paths(id).envPath, null);
    if (!env || env.id !== id) {
      throw new Error("environment not found: " + id);
    }
    env.runtime = env.runtime || { status: "stopped", pid: null };
    return env;
  }

  async saveRuntime(env) {
    await this.withLock(`env:${env.id}`, async () => {
      // 只落 runtime：启动要等最多 90 秒，期间别处可能改了名称或一致性策略，
      // 不能拿启动前读到的旧对象整份写回去。
      const latest = await this.readJSON(this.paths(env.id).envPath, null);
      if (!latest || latest.id !== env.id) {
        throw new Error("environment not found: " + env.id);
      }
      Object.assign(env, { ...latest, runtime: env.runtime });
      await this.writeJSON(this.paths(env.id).runtimePath, env.runtime || {});
      await this.writeEnv(env);
    });
  }
}
