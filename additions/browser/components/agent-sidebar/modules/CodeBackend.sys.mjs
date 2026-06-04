/* CodeBackend.sys.mjs — 搜索：在已落盘的 JS 语料 **+ 当前工作目录** 里搜字符串/正则。
 *
 * 纯 IOUtils 读 + JS 匹配（不依赖外部 ripgrep）。
 * 两个来源：① 语料 = ScriptsBackend 落盘的 <profile>/firefox-reverse-agent/js（scripts_capture_all/scripts_save 不带 toWorkspace）；
 *          ② 工作目录 = scripts_save(toWorkspace) 落的 scripts/、自己写的 work/、wasm/ 等——**关键修复**：
 *             以前 code_search 只搜语料，工作目录文件搜不到，逼模型反复退化成 run_node grep（实战转录多次踩到）。
 *             现在两边都搜；工作目录命中的 file 字段给**工作目录相对路径**，可原样 fs_read。
 */

// 工作目录里要搜的文本文件类型（跳过二进制 wasm/图片/字体等）。
const TEXT_EXT = new Set(["js", "cjs", "mjs", "ts", "json", "wat", "txt", "ndjson", "html", "css", "map"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".agent-tools", "webapi", "jsvmp"]);
const MAX_WS_FILES = 3000;

export class CodeBackend {
  /** @param {object} [opts] { workspace: WorkspaceBackend(getRoot) } —— 用于解析工作目录根（搜它里的文件）。 */
  constructor({ workspace } = {}) {
    this._workspace = workspace || null;
  }

  async corpusDir() {
    const dir = PathUtils.join(PathUtils.profileDir, "firefox-reverse-agent", "js");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    return dir;
  }

  _wsRoot(ctx) {
    try {
      if (ctx && ctx.workspaceRoot) {
        return ctx.workspaceRoot;
      }
      return (this._workspace && this._workspace.getRoot && this._workspace.getRoot()) || null;
    } catch {
      return null;
    }
  }

  /** 递归收集工作目录里的文本文件 → [{abs, name(相对路径)}]。跳过 node_modules/.git/trace 目录与二进制。 */
  async _workspaceFiles(ctx) {
    const root = this._wsRoot(ctx);
    if (!root) {
      return [];
    }
    const out = [];
    const walk = async (dir, rel, depth) => {
      if (depth > 6 || out.length >= MAX_WS_FILES) {
        return;
      }
      let kids = [];
      try {
        kids = await IOUtils.getChildren(dir);
      } catch {
        return;
      }
      for (const abs of kids) {
        if (out.length >= MAX_WS_FILES) {
          return;
        }
        const name = PathUtils.filename(abs);
        let info;
        try {
          info = await IOUtils.stat(abs);
        } catch {
          continue;
        }
        const childRel = rel ? rel + "/" + name : name;
        if (info.type === "directory") {
          if (SKIP_DIR.has(name) || name.startsWith(".")) {
            continue;
          }
          await walk(abs, childRel, depth + 1);
        } else {
          const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
          if (TEXT_EXT.has(ext)) {
            out.push({ abs, name: childRel });
          }
        }
      }
    };
    await walk(root, "", 0);
    return out;
  }

  /** 列出语料里的脚本文件。 */
  async listFiles() {
    const dir = await this.corpusDir();
    let files = [];
    try {
      files = await IOUtils.getChildren(dir);
    } catch {}
    files = files.filter(f => f.endsWith(".js"));
    return { ok: true, count: files.length, files: files.map(f => PathUtils.filename(f)) };
  }

  /**
   * 在语料 + 工作目录里搜索。
   * @param {object} p { query, regex=false, scriptUrl(限定文件名/路径子串), maxResults=50, ignoreCase=false }
   */
  async search({ query, regex = false, scriptUrl, maxResults = 50, ignoreCase = false } = {}, ctx) {
    if (!query) {
      throw new Error("query required");
    }
    // 来源①语料（abs，name=文件名）
    const dir = await this.corpusDir();
    let corpus = [];
    try {
      corpus = await IOUtils.getChildren(dir);
    } catch {}
    const entries = corpus
      .filter(f => f.endsWith(".js"))
      .map(abs => ({ abs, name: PathUtils.filename(abs), src: "corpus" }));
    // 来源②工作目录（abs，name=相对路径）
    try {
      for (const w of await this._workspaceFiles(ctx)) {
        entries.push({ abs: w.abs, name: w.name, src: "workspace" });
      }
    } catch {
      /* 没工作目录就只搜语料 */
    }
    // scriptUrl 过滤：对工作目录用原始子串、对语料用 sanitize 后的子串都试（命中其一即留）。
    let filtered = entries;
    if (scriptUrl) {
      const raw = String(scriptUrl);
      const san = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
      filtered = entries.filter(e => e.name.includes(raw) || e.name.includes(san));
    }

    const lineInfo = (text, idx) => {
      const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
      let lineEnd = text.indexOf("\n", idx);
      if (lineEnd < 0) {
        lineEnd = text.length;
      }
      let line = 1;
      for (let i = 0; i < idx; i++) {
        if (text.charCodeAt(i) === 10) {
          line++;
        }
      }
      const col = idx - lineStart;
      // **字符窗口**：以匹配位置 idx 为中心截 ±120 字符（不超出本行）。治压缩**单行**文件——旧版返回"整行前240字符"，
      // 对 minified 单行文件永远是文件开头那段、跟匹配位置无关、完全没用（实战里 mihuashi/toutiao/youdao 都因此
      // 反复退化成 run_node grep）。现在窗口跟着匹配走，单行压缩文件也能看到匹配上下文。
      const W = 120;
      const s = Math.max(lineStart, idx - W);
      const e = Math.min(lineEnd, idx + W);
      let snip = text.slice(s, e);
      if (s > lineStart) {
        snip = "…" + snip;
      }
      if (e < lineEnd) {
        snip = snip + "…";
      }
      return { line, col, text: snip.trim().slice(0, 280) };
    };
    const hits = [];
    let scanned = 0;
    let stop = false;
    const searchText = (name, src, text) => {
      if (regex) {
        const rg = new RegExp(query, ignoreCase ? "gi" : "g");
        let m;
        while ((m = rg.exec(text)) !== null) {
          const li = lineInfo(text, m.index);
          hits.push({ file: name, src, line: li.line, col: li.col, text: li.text });
          if (m.index === rg.lastIndex) {
            rg.lastIndex++;
          }
          if (hits.length >= maxResults) {
            return;
          }
        }
      } else {
        const hay = ignoreCase ? text.toLowerCase() : text;
        const needle = ignoreCase ? query.toLowerCase() : query;
        let from = 0;
        let idx;
        while ((idx = hay.indexOf(needle, from)) !== -1) {
          const li = lineInfo(text, idx);
          hits.push({ file: name, src, line: li.line, col: li.col, text: li.text });
          from = idx + needle.length;
          if (hits.length >= maxResults) {
            return;
          }
        }
      }
    };
    let next = 0;
    const worker = async () => {
      while (!stop) {
        const i = next++;
        if (i >= filtered.length || hits.length >= maxResults) {
          stop = true;
          break;
        }
        let bytes;
        try {
          bytes = await IOUtils.read(filtered[i].abs, { maxBytes: 3_000_000 });
        } catch {
          continue;
        }
        scanned++;
        searchText(filtered[i].name, filtered[i].src, new TextDecoder().decode(bytes));
        if (hits.length >= maxResults) {
          stop = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, filtered.length || 1) }, worker));
    return {
      ok: true,
      count: hits.length,
      scanned,
      truncated: hits.length >= maxResults,
      hits,
      note:
        "搜了**语料 + 工作目录**（src=workspace 的 file 是工作目录相对路径，可原样 fs_read；src=corpus 是抓取语料）。" +
        "没命中先确认目标文件已落盘（scripts_save / scripts_capture_all）、关键词/正则对，别急着退化成 run_node grep。",
    };
  }
}
