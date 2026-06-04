/* LedgerBackend.sys.mjs — 任务/跨会话「沉淀式记忆」账本（findings ledger），**Firefox 内置 SQLite 存储**。
 *
 * 治"上下文压缩后重新发现已确认事实 / 重走已否决死路"，并提供跨会话累积 + 关键词检索（recall）。
 * 借鉴 claude-mem / mem0 的结论（结构化存储胜散文摘要），但**去掉 claude-mem 的重型 sidecar**
 * （它要 Bun+Redis+Chroma+Express:37777，是给跨项目多用户的记忆服务设计的）。这里用 **Firefox 自带的
 * SQLite**（`resource://gre/modules/Sqlite.sys.mjs`）：**进程内、零外部依赖、不要 Node/Bun/Redis/Chroma/端口**。
 *   - 存储：全局 <profile>/firefox-reverse-agent/memory.sqlite，每条带 site + workspace 标签 → 跨会话累积。
 *   - 检索：Firefox 的 SQLite 没编 FTS5（实测 no such module），本量级（百~千条）用普通表 + LIKE 即时，无需 FTS。
 *   - **自动注入按工作目录隔离**：引擎每轮 + 压缩后只把**当前工作目录(=任务)**的账本注入系统提示（没设目录才退回按站点）。
 *     目录=任务身份：新目录=干净起步、开回原目录=续任务；跨任务/站点知识不自动污染上下文，靠 recall 显式捞。
 *   - 沉淀两路：① remember 工具（发现即记，write-at-discovery）；② mergeHandoff（压缩时从交接摘要自动抽事实）。
 *   - recall 工具：跨**全部**记忆按关键词/站点/类型检索（跨任务/站点检索桥；claude-mem 的 search 的轻量版）。
 */

const DIR = "firefox-reverse-agent";
const DB = "memory.sqlite";
const MD = "ledger.md";
const CAP_FACT = 120; // 每(站点,类型)封顶，防注入块无限膨胀（跨会话累积也要有界）
const CAP_DEAD = 60;

function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、；：,.;:!?！？()（）"'`*\-_]/g, "");
}
function _similarSql() {
  // dedup 用归一化全等（norm 列）；近重复（子串）在 append 里额外做一次内存判定。
  return true;
}

function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}

export class LedgerBackend {
  /** @param {object} [opts] { workspace: WorkspaceBackend(getRoot) } */
  constructor({ workspace } = {}) {
    this._workspace = workspace || null;
    this._conn = null;
    this._opening = null;
  }

  /** 懒开全局 SQLite 连接（单例，跨会话/多窗口共享同一记忆库；写经同一连接串行、并发安全）。 */
  async _db() {
    if (this._conn) {
      return this._conn;
    }
    if (this._opening) {
      return this._opening;
    }
    this._opening = (async () => {
      const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
      const dir = PathUtils.join(PathUtils.profileDir, DIR);
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      const path = PathUtils.join(dir, DB);
      const conn = await Sqlite.openConnection({ path });
      await conn.execute(
        "CREATE TABLE IF NOT EXISTS mem(" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, workspace TEXT, kind TEXT, text TEXT, ev TEXT, ts TEXT, norm TEXT)"
      );
      await conn.execute("CREATE INDEX IF NOT EXISTS i_site ON mem(site)");
      await conn.execute("CREATE INDEX IF NOT EXISTS i_ws ON mem(workspace)");
      await conn.execute("CREATE INDEX IF NOT EXISTS i_norm ON mem(norm)");
      this._conn = conn;
      this._opening = null;
      return conn;
    })();
    return this._opening;
  }

  _wsRoot(ctx) {
    try {
      if (ctx && ctx.workspaceRoot) {
        return ctx.workspaceRoot;
      }
      return (this._workspace && this._workspace.getRoot && this._workspace.getRoot()) || "";
    } catch {
      return "";
    }
  }

  /** 当前标签页主域（站点 key），取不到返回 ""。与 NotesBackend 同款。 */
  currentSite(ctx) {
    try {
      const win = agentWin(ctx);
      const uri = win && win.gBrowser && win.gBrowser.selectedBrowser && win.gBrowser.selectedBrowser.currentURI;
      const host = uri && uri.host;
      if (!host) {
        return "";
      }
      const parts = host.split(".").filter(Boolean);
      return parts.length > 2 ? parts.slice(-2).join(".") : host;
    } catch {
      return "";
    }
  }

  /** 当前任务作用域（**按工作目录隔离**：有目录→按目录；没目录→退回按站点，纯浏览时不至于全空）。
   *  目录 = 任务身份：新目录=干净起步、开回原目录=续任务；跨任务/站点检索走 recall。col 取自固定字符串，无注入风险。 */
  _scope(ctx) {
    // **只认会话自己绑定的目录**（ctx.workspaceRoot），**绝不退回全局 this._root**——那是跨会话共享的可变单例，
    // 上个会话设过的目录会被这个会话读到 → 串会话（用户实测：新会话还注入旧站点账本的真因）。
    const ws = (ctx && ctx.workspaceRoot) || "";
    if (ws) {
      return { col: "workspace", val: ws };
    }
    const site = this.currentSite(ctx);
    if (site) {
      return { col: "site", val: site };
    }
    return null;
  }

  /** 当前任务（**会话绑定的工作目录**）下的全部账本行，按 id 升序。用于**自动注入** + 渲染 ledger.md。
   *  关键：digest 自动注入**只认 ctx.workspaceRoot**——不退回全局 _root、不退回站点 → 没绑目录就干净（不串会话/不按站点灌）。 */
  async _contextRows(ctx) {
    const db = await this._db();
    const ws = (ctx && ctx.workspaceRoot) || "";
    if (!ws) {
      return [];
    }
    const rows = await db.execute(
      "SELECT kind,text,ev FROM mem WHERE workspace<>'' AND workspace=:v ORDER BY id",
      { v: ws }
    );
    return rows.map(r => ({
      kind: r.getResultByName("kind"),
      text: r.getResultByName("text"),
      ev: r.getResultByName("ev"),
    }));
  }

  /** 渲染人类可读 ledger.md 到**会话绑定的工作目录**（用户能直接打开看记忆沉淀）。只认 ctx.workspaceRoot：
   *  无目录就不写（避免拿全局 _root 把别的目录的 ledger.md 覆盖成空）。 */
  async _renderMd(ctx) {
    const ws = (ctx && ctx.workspaceRoot) || "";
    if (!ws) {
      return;
    }
    let rows = [];
    try {
      rows = await this._contextRows(ctx);
    } catch {
      return;
    }
    const facts = rows.filter(x => x.kind !== "deadend");
    const dead = rows.filter(x => x.kind === "deadend");
    const fmt = x => `- ${x.text}${x.ev ? `  〔证据:${x.ev}〕` : ""}`;
    const body =
      `# 逆向账本（findings ledger · SQLite 持久化 · 跨会话累积 · 每轮注入上下文）\n\n` +
      `## ✅ 已确认事实（${facts.length}）\n` +
      (facts.map(fmt).join("\n") || "（暂无）") +
      `\n\n## ⛔ 已否决 · 别重试（${dead.length}）\n` +
      (dead.map(fmt).join("\n") || "（暂无）") +
      `\n`;
    try {
      await IOUtils.writeUTF8(PathUtils.join(ws, MD), body);
    } catch {
      /* MD 是镜像，写失败不影响主存 */
    }
  }

  /** 内部：并入若干条（去重 + 每(站点,类型)封顶 + 渲染镜像）。返回 {added, dedup}。 */
  async _addMany(items, ctx) {
    const db = await this._db();
    const site = this.currentSite(ctx);
    const ws = (ctx && ctx.workspaceRoot) || "";   // 只记会话绑定目录（不退回全局 _root，避免把别的会话目录写进标签）
    const sc = this._scope(ctx);   // 任务作用域（会话目录优先、站点兜底）→ dedup/cap 都按这个隔离
    const ts = new Date().toISOString().slice(0, 10);
    let added = 0;
    let dedup = 0;
    for (const it of items) {
      const t = String(it.text || "").trim();
      if (!t) {
        continue;
      }
      const kind = it.kind === "deadend" ? "deadend" : "fact";
      const text = t.slice(0, 500);
      const ev = String(it.evidence || it.ev || "").trim().slice(0, 300);
      const norm = _norm(text);
      // 去重：同任务作用域(目录/站点) + 同 kind 下，归一化全等 或 子串近重复 → 删旧留新。
      const existing = sc ? await db.execute(
        `SELECT id,norm FROM mem WHERE kind=:k AND ${sc.col}<>'' AND ${sc.col}=:v`,
        { k: kind, v: sc.val }
      ) : [];
      const dropIds = [];
      for (const r of existing) {
        const en = r.getResultByName("norm") || "";
        if (!en) {
          continue;
        }
        const [a, b] = norm.length <= en.length ? [norm, en] : [en, norm];
        if (norm === en || (a.length >= 12 && b.includes(a))) {
          dropIds.push(r.getResultByName("id"));
        }
      }
      if (dropIds.length) {
        await db.execute(`DELETE FROM mem WHERE id IN (${dropIds.map(() => "?").join(",")})`, dropIds);
        dedup += dropIds.length;
      }
      await db.execute(
        "INSERT INTO mem(site,workspace,kind,text,ev,ts,norm) VALUES(:s,:w,:k,:t,:e,:ts,:n)",
        { s: site, w: ws, k: kind, t: text, e: ev, ts, n: norm }
      );
      if (!dropIds.length) {
        added++;
      }
      // 每(任务作用域,类型)封顶：删最旧超出部分。
      if (sc) {
        const cap = kind === "deadend" ? CAP_DEAD : CAP_FACT;
        await db.execute(
          `DELETE FROM mem WHERE id IN (SELECT id FROM mem WHERE kind=:k AND ${sc.col}=:v ORDER BY id DESC LIMIT -1 OFFSET :cap)`,
          { k: kind, v: sc.val, cap }
        );
      }
    }
    await this._renderMd(ctx);
    return { added, dedup };
  }

  async _counts(ctx) {
    const rows = await this._contextRows(ctx);
    return { facts: rows.filter(x => x.kind !== "deadend").length, deadends: rows.filter(x => x.kind === "deadend").length };
  }

  /**
   * 追加一条账本（**发现即记**）。确认一个事实/排除一条路就立刻调，别等压缩。
   * @param {object} p { text(必填), kind?("fact"|"deadend"), evidence? }
   */
  async append({ text, kind, evidence, ev } = {}, ctx) {
    if (!text || !String(text).trim()) {
      throw new Error("text 必填（一句话写清这条已确认的事实，或要排除的死路+理由）。");
    }
    const k = kind === "deadend" ? "deadend" : "fact";
    const r = await this._addMany([{ text, kind: k, evidence: evidence || ev }], ctx);
    const counts = await this._counts(ctx);
    return {
      ok: true,
      kind: k,
      counts,
      ...(r.dedup ? { dedupedOld: r.dedup } : {}),
      note:
        `已记入记忆库（${k === "deadend" ? "已否决·别重试" : "已确认事实"}）${r.dedup ? `，去重 ${r.dedup} 条旧的` : ""}。` +
        `本任务(工作目录)现有 ✅${counts.facts} / ⛔${counts.deadends}。**本目录的账本每轮注入你上下文顶部**——动手前先看：确认过的别重发现/重抓，否决的别重走。换目录=新任务从干净起步；要续旧任务就开回原目录(账本自动回来)，或用 recall 跨任务/站点翻历史。`,
    };
  }

  /** 整本格式化成注入块（引擎每轮 + 压缩后注入系统提示）。当前站点/任务无记忆 → ""。 */
  async digest({ maxChars = 6000 } = {}, ctx) {
    let rows = [];
    try {
      rows = await this._contextRows(ctx);
    } catch {
      return "";
    }
    if (!rows.length) {
      return "";
    }
    const facts = rows.filter(x => x.kind !== "deadend");
    const dead = rows.filter(x => x.kind === "deadend");
    const fmt = x => `- ${x.text}${x.ev ? `〔${x.ev}〕` : ""}`;
    let body =
      `【本任务记忆 · 你在**这个工作目录**沉淀的"已确认事实 / 已否决死路"（SQLite 跨会话保留、**按工作目录隔离**）——这是你的记忆。动手前先看这里：` +
      `已确认的**别重新发现/重抓/重解码**，已否决的**别重走**；要细节去工作目录文件 fs_read，要翻**其它任务/站点/历史**用 recall。】`;
    if (facts.length) {
      body += `\n\n✅ 已确认（${facts.length}）：\n` + facts.map(fmt).join("\n");
    }
    if (dead.length) {
      body += `\n\n⛔ 已否决·别重试（${dead.length}）：\n` + dead.map(fmt).join("\n");
    }
    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + "\n…（账本过长已截断，全文见工作目录 ledger.md，或用 recall 检索）";
    }
    return body;
  }

  /**
   * 检索记忆库（claude-mem 的 search 轻量版）：跨**全部站点/会话**按关键词/站点/类型查。
   * @param {object} p { query?, site?, kind?, limit? }
   */
  async recall({ query, site, kind, limit = 20 } = {}, ctx) {
    const db = await this._db();
    let sql = "SELECT site,kind,text,ev,ts FROM mem WHERE 1=1";
    const p = {};
    if (query && String(query).trim()) {
      sql += " AND text LIKE :q";
      p.q = "%" + String(query).trim() + "%";
    }
    if (site && String(site).trim()) {
      sql += " AND site LIKE :s";
      p.s = "%" + String(site).trim() + "%";
    }
    if (kind === "fact" || kind === "deadend") {
      sql += " AND kind=:k";
      p.k = kind;
    }
    sql += " ORDER BY id DESC LIMIT :lim";
    p.lim = Math.max(1, Math.min(100, limit | 0 || 20));
    let rows = [];
    try {
      rows = await db.execute(sql, p);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    const results = rows.map(r => ({
      site: r.getResultByName("site"),
      kind: r.getResultByName("kind"),
      text: r.getResultByName("text"),
      ev: r.getResultByName("ev"),
      ts: r.getResultByName("ts"),
    }));
    return {
      ok: true,
      count: results.length,
      results,
      note: results.length
        ? "命中历史记忆（**跨全部任务/会话/站点**——这是跨任务检索桥；本工作目录的记忆已自动注入上下文，不必 recall）。⚠ 站点会改版、工作目录可能已清空，历史结论用前先验证仍适用、产物按需重新落盘。"
        : "记忆库里没有匹配项（换关键词，或这是新任务/新方向）。",
    };
  }

  /**
   * 压缩时的**自动捕获安全网**：从 LLM 交接摘要里抽"已确认事实/已否决假设"两节的 bullet，并入记忆库（去重）。
   * 即便 Agent 没主动 remember，每次压缩也把确认结论沉淀进库——把"压缩能力"沉淀下来不衰减。
   */
  async mergeHandoff(handoffText, ctx) {
    const text = String(handoffText || "");
    if (!text) {
      return { ok: false };
    }
    let sec = null;
    const items = [];
    for (const ln of text.split("\n")) {
      const h = ln.match(/^\s*#{1,4}\s*(.+?)\s*$/);
      if (h) {
        const t = h[1];
        sec = /已确认|确认事实/.test(t)
          ? "fact"
          : /已否决|否决假设|别重试|死路|永不重试/.test(t)
            ? "deadend"
            : null;
        continue;
      }
      const b = ln.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (b && sec) {
        const t = b[1].trim();
        if (t.length >= 4) {
          items.push({ kind: sec, text: t });
        }
      }
      if (items.length >= 40) {
        break;
      }
    }
    if (!items.length) {
      return { ok: true, added: 0 };
    }
    try {
      const r = await this._addMany(items, ctx);
      return { ok: true, added: r.added, dedup: r.dedup };
    } catch {
      return { ok: false };
    }
  }
}
