/* WorkspaceBackend.sys.mjs — 工作目录能力：把一个本地目录绑定到当前会话，给 Agent 提供
 *   ① 作用域限定在该目录内的文件读写/列目录（fs_list/fs_read/fs_write/fs_mkdir）
 *   ② 在该目录内执行 node / python（run_node / run_python）
 *
 * 设计：
 * - 文件操作用 IOUtils/PathUtils（system ESM 全局可用）。所有路径一律相对工作目录解析，
 *   拒绝绝对路径逃逸与 `..` 越界 —— 避免误写到目录外。
 * - 执行用 Subprocess.sys.mjs（chrome JS 没有 child_process）：父进程(特权)spawn 宿主的
 *   node/python，cwd=工作目录，合并 stdout/stderr 回传。⚠ 这等于在用户机器上跑任意代码，
 *   属用户显式开启的工作站能力（目录由用户在侧边栏选定）。
 * - macOS GUI 启动的 app PATH 很精简（常缺 /opt/homebrew/bin、/usr/local/bin），所以解析
 *   可执行文件时除 Subprocess.pathSearch 外，再兜底搜常见安装位置 + 允许配置覆盖。
 * - Node 自测：无 IOUtils/Subprocess → 相关方法抛错，但模块仍可 import（纯逻辑可验证）。
 */

const OUT_CAP = 200 * 1024; // 单次执行回传输出上限（ToolRouter 还会再截到 ~20KB）
const READ_CAP = 512 * 1024; // fs_read 默认上限

function lazyESM(url) {
  try {
    return ChromeUtils.importESModule(url);
  } catch {
    return null;
  }
}

export class WorkspaceBackend {
  /** @param {object} [opts] { config?: ConfigStore-like(getNodePath/getPythonPath) } */
  constructor({ config } = {}) {
    this._root = null;
    this._config = config || null;
  }

  /** 绑定/切换工作目录（绝对路径）。返回规范化后的根。
   * 注意：此 setter 设置的是后备全局根。优先使用 ctx.workspaceRoot（工具执行时由会话注入）。 */
  setRoot(path) {
    const p = path && String(path).trim();
    this._root = p || null;
    return this._root;
  }
  /** 返回当前生效的工作目录根：ctx.workspaceRoot（会话级，优先）→ this._root（全局后备）。 */
  getRoot(ctx) {
    return this._resolveRoot(ctx);
  }
  /** ctx.workspaceRoot 优先于全局 this._root，实现多窗口/多会话隔离。 */
  _resolveRoot(ctx) {
    return (ctx && ctx.workspaceRoot) || this._root;
  }

  _assertRoot(ctx) {
    const r = this._resolveRoot(ctx);
    if (!r) {
      throw new Error("尚未设置工作目录：请在侧边栏点「打开目录」选择一个本地目录。");
    }
    return r;
  }

  /** 自动归整：新建脚本/数据文件时，**裸文件名**（无子目录、非绝对路径）按扩展名自动归到子目录，
   *  让工作目录默认就是整洁的，不靠模型记得加 work/。已显式带目录（含 /）或在保留名单里的不动。 */
  _autoTidy(rel) {
    let r = String(rel ?? "").replace(/\\/g, "/").trim();
    if (!r || r.includes("/") || r.startsWith(".")) {
      return rel; // 已带子目录 / 隐藏文件（.agent-tools 等）→ 尊重原样
    }
    const low = r.toLowerCase();
    // 必须留在根的工具约定文件：npm/pip/ts 等靠它在根才能跑；进展/账本/笔记/说明用户要一眼看到。
    const ROOT_KEEP = new Set([
      "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
      "requirements.txt", "pipfile", "pyproject.toml", "tsconfig.json", "jsconfig.json",
    ]);
    if (
      ROOT_KEEP.has(low) ||
      /\.md$/i.test(r) ||
      /^(progress|ledger|notes|readme|report|结论|conclusion)[.\-_]/i.test(r)
    ) {
      return rel;
    }
    const ext = (r.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
    // 脚本 → work/（你写的 loader/实验脚本）；数据 → work/（中间产物）。signer 源码用 scripts_save 落 scripts/，
    // wasm 用 scripts_save 落 wasm/——那是另两个工具的事，这里只管 fs_write 新建的散文件。
    if (["js", "cjs", "mjs", "ts", "py", "json", "txt", "ndjson", "hex", "wat"].includes(ext)) {
      return "work/" + r;
    }
    return rel;
  }

  /** 把用户给的相对/绝对路径安全解析为工作目录内的绝对路径（拒绝越界）。 */
  _resolve(rel, ctx) {
    const root = this._assertRoot(ctx);
    let r = String(rel ?? "").replace(/\\/g, "/").trim();
    if (!r || r === "." || r === "./") {
      return root;
    }
    const segs = r.split("/").filter(s => s && s !== ".");
    if (segs.includes("..")) {
      throw new Error("路径不允许包含 ..（必须在工作目录内）：" + rel);
    }
    let abs;
    if (r.startsWith("/")) {
      abs = "/" + segs.join("/");
      if (abs !== root && !abs.startsWith(root.replace(/\/$/, "") + "/")) {
        throw new Error("路径越界（必须在工作目录内）：" + rel);
      }
    } else {
      abs = PathUtils.join(root, ...segs);
    }
    return abs;
  }

  /** 工作目录状态。 */
  async info() {
    const root = this._root;
    if (!root) {
      return { ok: true, set: false, root: null, note: "未设置工作目录" };
    }
    let exists = false;
    let isDir = false;
    try {
      const s = await IOUtils.stat(root);
      exists = true;
      isDir = s.type === "directory";
    } catch {
      /* 不存在 */
    }
    return { ok: true, set: true, root, exists, isDir };
  }

  /** 列出工作目录（或子目录）下的文件/目录，浅递归（默认 2 层），上限 400 条。 */
  async list({ subdir = "", depth = 2 } = {}, ctx) {
    const base = this._resolve(subdir, ctx);
    const maxDepth = Math.min(Math.max(1, depth | 0), 3);
    const baseRel = String(subdir || "").replace(/\\/g, "/").replace(/^\.?\/*/, "").replace(/\/+$/, "");
    const out = [];
    const walk = async (dir, rel, lvl) => {
      let children;
      try {
        children = await IOUtils.getChildren(dir);
      } catch {
        return;
      }
      for (const c of children) {
        if (out.length >= 400) {
          return;
        }
        const name = PathUtils.filename(c);
        if (name === ".DS_Store") {
          continue;
        }
        let st;
        try {
          st = await IOUtils.stat(c);
        } catch {
          continue;
        }
        const isDir = st.type === "directory";
        const relPath = rel ? rel + "/" + name : name;
        out.push({ path: relPath, type: isDir ? "dir" : "file", size: isDir ? undefined : st.size || 0 });
        if (isDir && lvl < maxDepth) {
          await walk(c, relPath, lvl + 1);
        }
      }
    };
    await walk(base, baseRel, 1);
    out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
    return { ok: true, root: this._resolveRoot(ctx), subdir: subdir || "", count: out.length, entries: out };
  }

  /** 读工作目录内的文本文件。 */
  /** 裸文件名在根目录找不到时，扫**一层子目录**(work/scripts/wasm/…)按文件名匹配，返回 {abs, rel} 或 null。
   *  治实战痛点："fs_write 自动归整到 work/、或文件落在 scripts//wasm/，之后按根路径 fs_read/run_node 报不存在"
   *  ——写了却读不到（用户实测 run_sign.js 凭空消失）。只扫一层、命中即返回，开销小。 */
  async _findByBasename(name, ctx) {
    const root = this._assertRoot(ctx);
    const atRoot = PathUtils.join(root, name);
    if (await IOUtils.exists(atRoot)) {
      return { abs: atRoot, rel: name };
    }
    let children = [];
    try {
      children = await IOUtils.getChildren(root);
    } catch {
      return null;
    }
    for (const child of children) {
      let isDir = false;
      try {
        isDir = (await IOUtils.stat(child)).type === "directory";
      } catch {
        /* 取不到类型就跳过 */
      }
      if (!isDir) {
        continue;
      }
      const cand = PathUtils.join(child, name);
      if (await IOUtils.exists(cand)) {
        return { abs: cand, rel: PathUtils.filename(child) + "/" + name };
      }
    }
    return null;
  }

  async read({ path, offset, limit, maxBytes = READ_CAP } = {}, ctx) {
    if (!path) {
      throw new Error("path required");
    }
    let abs = this._resolve(path, ctx);
    let size = 0;
    try {
      size = (await IOUtils.stat(abs)).size || 0;
    } catch {
      // 兜底：裸文件名根目录没有 → 扫一层子目录按文件名找（自动归整到 work/、或落在 scripts//wasm/ 后，
      // 按根路径读会"不存在"——写了却读不到）。找到就用，并把**真实相对路径**回报给模型。
      const found = !String(path).includes("/") ? await this._findByBasename(path, ctx) : null;
      if (found) {
        abs = found.abs;
        size = (await IOUtils.stat(abs)).size || 0;
        path = found.rel; // 回报真实相对路径，模型后续按这个用
      } else {
        throw new Error(
          "文件不存在：" + path + "（根目录与各子目录都没有同名文件；用 fs_list 看实际文件/路径，别凭记忆猜路径）"
        );
      }
    }
    const hasSlice = offset != null || limit != null;
    const off = Math.max(0, offset | 0);
    const BIG = 32 * 1024;
    // 大文件**未指定切片就整读** → 不 dump 全文（防上下文爆炸/卡死/断掉）。只回头部 + 硬提示：
    // 把大文件当数据处理——code_search 查询 / run_node 写脚本提取&转换 / 或带 offset+limit 切片读。
    if (!hasSlice && size > BIG) {
      const headBytes = await IOUtils.read(abs, { maxBytes: 2000 });
      const head = new TextDecoder("utf-8", { fatal: false }).decode(headBytes);
      return {
        ok: true,
        path,
        size,
        partial: true,
        truncated: true,
        content: head,
        note:
          `文件 ${size} 字节，过大未整读（仅回头部 2KB）。**大文件是数据、别整读进对话**：` +
          `① code_search("关键词","${path}") 精搜片段；② 写 run_node 脚本 fs.readFileSync 提取/转换你要的部分，只回小结果或 fs.writeFileSync 落盘（内容不进对话）；` +
          `③ 确需读某段用 fs_read({path,offset,limit}) 切片。`,
      };
    }
    const cap = Math.min((limit != null ? limit : maxBytes) | 0 || READ_CAP, 4 * 1024 * 1024);
    const bytes = await IOUtils.read(abs, { offset: off, maxBytes: cap });
    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { ok: true, path, size, offset: off, bytes: bytes.length, truncated: off + bytes.length < size, content };
  }

  /** 写工作目录内文本文件（自动建父目录）。append=true 时**追加**而非覆盖：
   *  用于大文件分多次写——避免把整个文件当单次 fs_write 的 content 导致输出被 max_tokens 截断。 */
  async write({ path, content = "", append = false } = {}, ctx) {
    if (!path) {
      throw new Error("path required");
    }
    const tidied = this._autoTidy(path); // 裸脚本/数据文件名 → 自动归 work/，保持根目录整洁
    const abs = this._resolve(tidied, ctx);
    const dir = PathUtils.parent(abs);
    if (dir) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    const text = String(content);
    if (append) {
      // appendOrCreate：文件不存在则建、存在则在尾部追加（首段也可直接用）。
      await IOUtils.writeUTF8(abs, text, { mode: "appendOrCreate" });
    } else {
      await IOUtils.writeUTF8(abs, text, { tmpPath: abs + ".tmp" });
    }
    // 回报**实际落盘路径**（tidied）——若自动归整了，告诉模型后续 fs_read/run_node 用这个路径。
    const out = { ok: true, path: tidied, bytes: text.length, append: !!append };
    if (tidied !== path) {
      out.tidiedFrom = path;
      out.note = `已自动归整到 \`${tidied}\`（保持工作目录根整洁）。后续 fs_read/run_node 用这个路径。`;
    }
    return out;
  }

  /** 在工作目录内复制文件（服务端直接拷，内容**不经模型输出**）。
   *  用途：要在 node 里跑/改一个已落盘的大文件（如 scripts_save 落盘的 wasm-bindgen glue），
   *  复制现成的 + 只写几十行小 loader/补丁；**绝不用 fs_write 把大文件全文重新生成**
   *  （那要模型一轮吐上万字符 → 撞单轮输出上限被截断 → 卡死/空转）。 */
  async copy({ src, dst, overwrite = true } = {}, ctx) {
    if (!src || !dst) {
      throw new Error("src + dst required");
    }
    const absSrc = this._resolve(src, ctx);
    const absDst = this._resolve(dst, ctx);
    let size = 0;
    try {
      size = (await IOUtils.stat(absSrc)).size || 0;
    } catch {
      throw new Error("源文件不存在：" + src);
    }
    const dir = PathUtils.parent(absDst);
    if (dir) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    }
    await IOUtils.copy(absSrc, absDst, { noOverwrite: !overwrite });
    return { ok: true, src, dst, bytes: size };
  }

  /** 在工作目录内建子目录。 */
  async mkdir({ path } = {}, ctx) {
    if (!path) {
      throw new Error("path required");
    }
    const abs = this._resolve(path, ctx);
    await IOUtils.makeDirectory(abs, { ignoreExisting: true, createAncestors: true });
    return { ok: true, path };
  }

  /** 删除工作目录内的文件/目录（recursive 删目录）。 */
  async remove({ path, recursive = false } = {}, ctx) {
    if (!path) {
      throw new Error("path required");
    }
    const abs = this._resolve(path, ctx);
    if (abs === this._resolveRoot(ctx)) {
      throw new Error("不能删除工作目录根");
    }
    await IOUtils.remove(abs, { recursive: !!recursive, ignoreAbsent: true });
    return { ok: true, path };
  }

  /** 解析 node/python 可执行文件：配置覆盖 → PATH 搜索 → 常见安装位置兜底。 */
  async _resolveExe(kind) {
    const names = kind === "node" ? ["node"] : ["python3", "python"];
    // 1. 配置覆盖
    try {
      const cfg = this._config && (kind === "node" ? this._config.getNodePath?.() : this._config.getPythonPath?.());
      if (cfg && (await IOUtils.exists(cfg))) {
        return cfg;
      }
    } catch {
      /* ignore */
    }
    // 2. PATH 搜索
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (Subprocess && Subprocess.pathSearch) {
      for (const n of names) {
        try {
          const p = await Subprocess.pathSearch(n);
          if (p) {
            return p;
          }
        } catch {
          /* not found, keep trying */
        }
      }
    }
    // 3. 常见安装位置（GUI 启动 PATH 精简，homebrew/usr-local 不在内）
    const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];
    for (const d of dirs) {
      for (const n of names) {
        const p = d + "/" + n;
        try {
          if (await IOUtils.exists(p)) {
            return p;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  /**
   * 构造派生进程的 PATH：exe 所在目录 + 常见 bin + 继承的 PATH（去重保序）。
   * 根因：GUI(Finder/Dock) 启动的浏览器 PATH 精简(常无 /usr/local/bin、/opt/homebrew/bin)，
   * node 本体能被 _resolveExe 兜底找到，但 node 再 spawn 兄弟工具(npm/npx)时用的是**继承的精简 PATH**→找不到=「npm 不可用」。
   * 把 exe 目录并入 PATH，node 的 child_process 与 npm 的 `env node` shebang 就都能寻到。
   */
  _mergedPath(exe) {
    let base = "";
    try {
      const env =
        Services.env || Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
      base = (env && env.get("PATH")) || "";
    } catch {
      /* ignore */
    }
    const parts = [];
    if (exe) {
      try {
        parts.push(PathUtils.parent(exe));
      } catch {
        /* ignore */
      }
    }
    for (const d of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/opt/local/bin", "/usr/sbin", "/sbin"]) {
      parts.push(d);
    }
    for (const d of base.split(":")) {
      if (d) parts.push(d);
    }
    const seen = new Set();
    return parts.filter(p => p && !seen.has(p) && seen.add(p)).join(":");
  }

  /** 派生子进程并捕获合并输出（node/python/npm 共用）。PATH 经 _mergedPath 补全。 */
  async _spawn(command, argv, { root, timeoutMs = 120000 } = {}) {
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (!Subprocess) {
      throw new Error("Subprocess 不可用（须在 firefox-reverse 浏览器内运行）");
    }
    const proc = await Subprocess.call({
      command,
      arguments: argv,
      workdir: root,
      environment: { PATH: this._mergedPath(command) },
      environmentAppend: true, // 继承父进程环境，仅覆盖 PATH（补 exe 目录+常见 bin，让 npm/npx 可寻）
      stderr: "stdout", // 合并 stderr 到 stdout 一并回传
    });
    const T = lazyESM("resource://gre/modules/Timer.sys.mjs");
    let timedOut = false;
    let timer = null;
    if (T && T.setTimeout) {
      timer = T.setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, Math.max(1000, timeoutMs | 0));
    }
    let output = "";
    let capped = false;
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        output += chunk;
        if (output.length > OUT_CAP) {
          output = output.slice(0, OUT_CAP) + "\n…（输出已截断）";
          capped = true;
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    } finally {
      if (timer && T && T.clearTimeout) {
        T.clearTimeout(timer);
      }
    }
    let exitCode = null;
    try {
      ({ exitCode } = await proc.wait());
    } catch {
      /* killed */
    }
    return { exitCode, timedOut, capped, output };
  }

  async _run(kind, { code, file, args = [], timeoutMs = 120000 } = {}, ctx) {
    const root = this._assertRoot(ctx);
    await IOUtils.makeDirectory(root, { ignoreExisting: true, createAncestors: true });
    const exe = await this._resolveExe(kind);
    if (!exe) {
      throw new Error(
        `找不到 ${kind} 可执行文件。请确认已安装并在 PATH 中，或在设置里配置 ${kind} 路径` +
          "（GUI 启动的浏览器 PATH 较精简，homebrew/usr-local 可能搜不到）。"
      );
    }
    const argv = [];
    if (code != null && String(code).length) {
      argv.push(kind === "node" ? "-e" : "-c", String(code));
    } else if (file) {
      // 兜底：传了裸文件名但根目录没有 → 扫一层子目录按文件名找（自动归整到 work/、或落在 scripts//wasm/）。
      let abs = this._resolve(file, ctx);
      if (!file.includes("/") && !(await IOUtils.exists(abs))) {
        const found = await this._findByBasename(file, ctx);
        if (found) {
          abs = found.abs;
        }
      }
      argv.push(abs);
    } else {
      throw new Error("需要 code（内联代码）或 file（目录内脚本路径）之一");
    }
    for (const a of Array.isArray(args) ? args : []) {
      argv.push(String(a));
    }
    const r = await this._spawn(exe, argv, { root, timeoutMs });
    const out = {
      ok: r.exitCode === 0 && !r.timedOut,
      kind,
      exe,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      capped: r.capped,
      cwd: root,
      output: r.output,
    };
    // 反卡死：内联 code 很大且反复改跑 → 每个 assistant 消息都带这段大 code（工具入参不受结果上限约束）
    // → 上下文飞涨 → 大请求让中转站/推理模型 >300s 出不来响应头 → 超时卡死。引导改用落盘脚本。
    if (code != null && String(code).length > 3000) {
      out.note =
        `本次 inline code ${String(code).length} 字符偏大。反复改跑大 inline 脚本会把它一份份堆进上下文→拖慢甚至 300s 超时。` +
        `建议：fs_write 到 work/xxx.${kind === "node" ? "js" : "py"} 一次，之后 run_${kind}(file:"work/xxx...") 跑、只改文件，不再内联大段代码。`;
    }
    return out;
  }

  /** 解析 npm：优先 node 同级目录（版本匹配最可靠），再 PATH/常见目录兜底。 */
  async _resolveNpm() {
    try {
      const node = await this._resolveExe("node");
      if (node) {
        const sib = PathUtils.join(PathUtils.parent(node), "npm");
        if (await IOUtils.exists(sib)) {
          return sib;
        }
      }
    } catch {
      /* ignore */
    }
    const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
    const Subprocess = SP && SP.Subprocess;
    if (Subprocess && Subprocess.pathSearch) {
      try {
        const p = await Subprocess.pathSearch("npm");
        if (p) {
          return p;
        }
      } catch {
        /* ignore */
      }
    }
    for (const d of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/opt/local/bin"]) {
      const p = d + "/npm";
      try {
        if (await IOUtils.exists(p)) {
          return p;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /**
   * npm install（在工作目录内）。装到 <工作目录>/node_modules，run_node 里可直接 require。
   * 解决「三方加密库正常 npm 加载」：jsdom / crypto-js / sm-crypto / node-forge 等。
   * @param {object} p { packages?: string[]|string, args?: string[], timeoutMs?: number }
   */
  async npmInstall({ packages = [], args = [], timeoutMs = 300000 } = {}, ctx) {
    const root = this._assertRoot(ctx);
    await IOUtils.makeDirectory(root, { ignoreExisting: true, createAncestors: true });
    const npm = await this._resolveNpm();
    if (!npm) {
      throw new Error(
        "找不到 npm（node 同级目录与 PATH 都没有）。请确认 Node 安装完整（自带 npm），或在设置配置 node 路径。"
      );
    }
    const pkgs = (Array.isArray(packages) ? packages : [packages]).filter(Boolean).map(String);
    const extra = (Array.isArray(args) ? args : []).map(String);
    const argv = ["install", ...pkgs, ...extra];
    const r = await this._spawn(npm, argv, { root, timeoutMs });
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      npm,
      packages: pkgs,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      capped: r.capped,
      cwd: root,
      output: r.output,
      note:
        r.exitCode === 0 && !r.timedOut
          ? `已安装 ${pkgs.length ? pkgs.join(", ") : "package.json 依赖"} 到 ${root}/node_modules，run_node 里可直接 require。`
          : "npm install 失败/超时，看 output。常见原因：无网络 / 包名错 / 需先有 package.json。",
    };
  }

  runNode(a = {}, ctx) {
    return this._run("node", a, ctx);
  }
  runPython(a = {}, ctx) {
    return this._run("python", a, ctx);
  }
}
