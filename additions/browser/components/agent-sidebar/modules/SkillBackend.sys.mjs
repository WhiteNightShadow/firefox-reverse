/* SkillBackend.sys.mjs — 通用 SkillRegistry。
 *
 * 来源（后者同名覆盖前者）：
 * 1. 浏览器内置 reverse-engineering Skill；
 * 2. ~/.firefox-reverse/skills/<name>/SKILL.md；
 * 3. <工作目录>/.agents/skills/<name>/SKILL.md；
 * 4. <工作目录>/.firefox-reverse/skills/<name>/SKILL.md。
 *
 * 兼容：skill_get 不传 name 时仍返回原来的内置逆向方法论，并释放模板。
 */

const BUILTIN_NAME = "reverse-engineering";
const BUILTIN_URL = "chrome://browser/content/agent-sidebar/skill-reverse.md";
const MAX_SKILL_CHARS = 1024 * 1024;
const MAX_RESOURCE_CHARS = 2 * 1024 * 1024;
const TEMPLATES = [
  "node-env-loader.js",
  "wasm-signer-loader.js",
  "request-template.js",
  "webpack-chunk-loader.js",
  "jsvmp-const-harvest.js",
  "wasm-call-logger.js",
];

function stripQuotes(value) {
  const s = String(value || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 只解析 Agent Skills 发现所需的 name/description，正文保持原样交给模型。 */
export function parseSkillFrontmatter(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) {
    return { name: "", description: "", body: src };
  }
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { name: "", description: "", body: src };
  }
  const lines = match[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value === "|" || value === ">") {
      const folded = value === ">";
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(folded ? " " : "\n");
    }
    meta[key] = stripQuotes(value);
  }
  return {
    name: String(meta.name || "").trim(),
    description: String(meta.description || "").trim().slice(0, 500),
    body: src.slice(match[0].length),
  };
}

function validSkillName(name) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name || ""));
}

function safeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const parts = raw.split("/").filter(Boolean);
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || parts.some(p => p === "." || p === "..")) {
    throw new Error("resource path 必须是 Skill 目录内的安全相对路径");
  }
  return parts;
}

function chunkText(text, params = {}) {
  const hasRange = params.offset != null || params.limit != null;
  if (!hasRange) return { text, totalChars: text.length, offset: 0, nextOffset: null, truncated: false };
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const limit = Math.min(16000, Math.max(1, Math.floor(Number(params.limit) || 12000)));
  const value = text.slice(offset, offset + limit);
  const nextOffset = offset + value.length < text.length ? offset + value.length : null;
  return { text: value, totalChars: text.length, offset, nextOffset, truncated: nextOffset != null };
}

function pathInside(root, candidate) {
  const normalize = value => {
    let p = String(value || "").replace(/[\\/]+/g, "/").replace(/\/$/, "");
    if (/^[A-Za-z]:\//.test(p)) p = p.toLowerCase();
    return p;
  };
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(r + "/");
}

export class SkillRegistry {
  constructor({ workspace } = {}) {
    this._builtinCache = null;
    this._workspace = workspace || null;
  }

  async _readChrome(url) {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    return new Promise((resolve, reject) => {
      try {
        NetUtil.asyncFetch({ uri: url, loadUsingSystemPrincipal: true }, (inputStream, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(new Error("读资源失败 status=" + status + " " + url));
            return;
          }
          try {
            resolve(NetUtil.readInputStreamToString(inputStream, inputStream.available(), { charset: "UTF-8" }));
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  _homeDir() {
    try {
      return Services.env.get("HOME") || Services.env.get("USERPROFILE") || PathUtils.homeDir || "";
    } catch {
      try {
        return PathUtils.homeDir || "";
      } catch {
        return "";
      }
    }
  }

  _workspaceRoot(ctx) {
    return (
      (ctx && ctx.workspaceRoot) ||
      (this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx)) ||
      ""
    );
  }

  _roots(ctx) {
    const roots = [];
    const home = this._homeDir();
    if (home) roots.push({ source: "user", root: PathUtils.join(home, ".firefox-reverse", "skills") });
    const workspace = this._workspaceRoot(ctx);
    if (workspace) {
      roots.push({ source: "workspace", root: PathUtils.join(workspace, ".agents", "skills") });
      roots.push({ source: "workspace", root: PathUtils.join(workspace, ".firefox-reverse", "skills") });
    }
    return roots;
  }

  async _readLocal(path, maxChars) {
    const st = await IOUtils.stat(path);
    if (st.type !== "regular") throw new Error("不是普通文件: " + path);
    if (st.size > maxChars) throw new Error(`文件超过限制（${Math.floor(maxChars / 1024)}KB）`);
    return IOUtils.readUTF8(path);
  }

  async _scanRoot(entry) {
    let children;
    try {
      children = await IOUtils.getChildren(entry.root);
    } catch {
      return [];
    }
    const found = [];
    let realRoot = null;
    if (typeof IOUtils.realPath === "function") {
      try { realRoot = await IOUtils.realPath(entry.root); } catch { return []; }
    }
    for (const dir of children.slice(0, 200)) {
      try {
        const stat = await IOUtils.stat(dir);
        if (stat.type !== "directory") continue;
        if (realRoot) {
          const realDir = await IOUtils.realPath(dir);
          if (!pathInside(realRoot, realDir)) continue;
        }
        const skillPath = PathUtils.join(dir, "SKILL.md");
        if (typeof IOUtils.realPath === "function") {
          const [realDir, realSkill] = await Promise.all([IOUtils.realPath(dir), IOUtils.realPath(skillPath)]);
          if (!pathInside(realDir, realSkill)) continue;
        }
        const text = await this._readLocal(skillPath, MAX_SKILL_CHARS);
        const meta = parseSkillFrontmatter(text);
        const folderName = PathUtils.filename(dir);
        const name = meta.name || folderName;
        if (!validSkillName(name)) continue;
        found.push({
          name,
          description: meta.description || `本地 Skill：${name}`,
          source: entry.source,
          root: dir,
          path: skillPath,
        });
      } catch {
        /* 单个 Skill 损坏不影响其它条目 */
      }
    }
    return found;
  }

  async _catalog(ctx) {
    const map = new Map();
    map.set(BUILTIN_NAME, {
      name: BUILTIN_NAME,
      description: "Firefox Reverse 内置的 JS 逆向、签名定位、补环境与实打验证方法论",
      source: "builtin",
      url: BUILTIN_URL,
    });
    if (typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined") {
      for (const root of this._roots(ctx)) {
        for (const skill of await this._scanRoot(root)) {
          map.set(skill.name, skill);
        }
      }
    }
    return [...map.values()];
  }

  async list(_params = {}, ctx = {}) {
    try {
      const skills = await this._catalog(ctx);
      return {
        ok: true,
        count: skills.length,
        skills: skills.map(({ root, path, url, ...s }) => s),
        roots:
          typeof PathUtils !== "undefined"
            ? this._roots(ctx).map(x => ({ source: x.source, path: x.root }))
            : [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async _readBuiltin() {
    if (!this._builtinCache) this._builtinCache = await this._readChrome(BUILTIN_URL);
    return this._builtinCache;
  }

  async _releaseTemplates(ctx) {
    const root = this._workspaceRoot(ctx);
    if (!root) return [];
    const dir = PathUtils.join(root, ".agent-tools", "templates");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    const rels = [];
    for (const name of TEMPLATES) {
      const dest = PathUtils.join(dir, name);
      const rel = ".agent-tools/templates/" + name;
      rels.push(rel);
      try {
        if ((await IOUtils.stat(dest)).size > 0) continue;
      } catch {}
      try {
        const text = await this._readChrome("chrome://browser/content/agent-sidebar/templates/" + name);
        await IOUtils.writeUTF8(dest, text);
      } catch {
        /* 单个模板失败不影响 Skill 正文 */
      }
    }
    return rels;
  }

  async _listResources(root, dir = root, prefix = "", depth = 0, out = []) {
    if (depth > 3 || out.length >= 100) return out;
    let children = [];
    try {
      children = await IOUtils.getChildren(dir);
    } catch {
      return out;
    }
    for (const child of children) {
      if (out.length >= 100) break;
      const name = PathUtils.filename(child);
      if (!prefix && name === "SKILL.md") continue;
      try {
        if (typeof IOUtils.realPath === "function") {
          const [realRoot, realChild] = await Promise.all([IOUtils.realPath(root), IOUtils.realPath(child)]);
          if (!pathInside(realRoot, realChild)) continue;
        }
        const st = await IOUtils.stat(child);
        const rel = prefix ? prefix + "/" + name : name;
        if (st.type === "directory") await this._listResources(root, child, rel, depth + 1, out);
        else if (st.type === "regular") out.push(rel);
      } catch {}
    }
    return out;
  }

  /** 无 name 时兼容旧 skill_get；传 name 时读取任意已发现的 Skill。 */
  async get(params = {}, ctx = {}) {
    try {
      const legacyDefault = !params.name;
      let name = String(params.name || BUILTIN_NAME).trim();
      const builtinAlias = ["reverse", "skill-reverse", "builtin"].includes(name);
      if (builtinAlias) name = BUILTIN_NAME;
      const catalog = await this._catalog(ctx);
      // 无参数是公开兼容契约：即使本地存在同名 Skill，也必须返回原内置方法论。
      const descriptor = legacyDefault || builtinAlias
        ? {
            name: BUILTIN_NAME,
            description: "Firefox Reverse 内置的 JS 逆向、签名定位、补环境与实打验证方法论",
            source: "builtin",
            url: BUILTIN_URL,
          }
        : catalog.find(s => s.name === name);
      if (!descriptor) {
        return { ok: false, error: `未找到 Skill "${name}"；先调用 skill_list 查看可用名称` };
      }
      if (descriptor.source === "builtin") {
        const fullSkill = await this._readBuiltin();
        const chunk = chunkText(fullSkill, params);
        let templates = [];
        try { templates = await this._releaseTemplates(ctx); } catch {}
        return {
          ok: true,
          name: descriptor.name,
          description: descriptor.description,
          source: descriptor.source,
          skill: chunk.text,
          totalChars: chunk.totalChars,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          truncated: chunk.truncated,
          templates,
          resources: [],
          note: templates.length
            ? `已释放脚手架：${templates.join("、")}`
            : "设置工作目录后再次读取，可自动释放逆向脚手架。",
        };
      }
      const fullSkill = await this._readLocal(descriptor.path, MAX_SKILL_CHARS);
      const chunk = chunkText(fullSkill, params);
      return {
        ok: true,
        name: descriptor.name,
        description: descriptor.description,
        source: descriptor.source,
        skill: chunk.text,
        totalChars: chunk.totalChars,
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        truncated: chunk.truncated,
        resources: await this._listResources(descriptor.root),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async readResource(params = {}, ctx = {}) {
    try {
      const name = String(params.name || "").trim();
      const parts = safeRelativePath(params.path);
      const descriptor = (await this._catalog(ctx)).find(s => s.name === name);
      if (!descriptor) throw new Error(`未找到 Skill "${name}"`);
      if (descriptor.source === "builtin") throw new Error("内置 Skill 没有可直接读取的附加资源");
      const path = PathUtils.join(descriptor.root, ...parts);

      // 支持时用真实路径再校验一次，阻止目录内符号链接逃逸到 Skill 根之外。
      if (typeof IOUtils.realPath === "function") {
        const [realRoot, realPath] = await Promise.all([IOUtils.realPath(descriptor.root), IOUtils.realPath(path)]);
        if (!pathInside(realRoot, realPath)) throw new Error("资源路径越过 Skill 目录");
      }
      const fullContent = await this._readLocal(path, MAX_RESOURCE_CHARS);
      const chunk = chunkText(fullContent, params);
      return {
        ok: true,
        name,
        path: parts.join("/"),
        content: chunk.text,
        totalChars: chunk.totalChars,
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        truncated: chunk.truncated,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}

/** 旧类名保留，避免 Backends/外部补丁导入路径失效。 */
export class SkillBackend extends SkillRegistry {}
