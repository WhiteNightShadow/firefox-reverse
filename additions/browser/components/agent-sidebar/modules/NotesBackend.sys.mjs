/* NotesBackend.sys.mjs — 逆向「进展笔记」缓存（跨会话、按站点、仅记验证通过的结论）。
 *
 * 落盘到 <工作目录>/.frx-notes.ndjson（行式 append，每行一条）。每条：
 *   {date, site, topic, kind, status:"verified", note, verifiedBy}
 * 用途：下次再逆向同一站点时，先看历史突破点/坑（每轮自动注入当前站点摘要到系统提示）。
 * ⚠ 爬虫站点常改版 → 笔记只供参考、非长期适用；只有**验证确认可行**的结论才落盘。
 */

const FILE = ".frx-notes.ndjson";
const KINDS = ["breakthrough", "pitfall", "env", "algo", "endpoint", "note"]; // 突破点/坑/指纹/算法/接口/其他
const PER_SITE_CAP = 40; // 每站点最多保留多少条，超了按优先级+时间淘汰
const KIND_PRIORITY = { breakthrough: 5, algo: 4, endpoint: 3, env: 2, pitfall: 2, note: 1 };

// 归一化（去空白/标点/大小写）用于近重复判定
function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、；：,.;:!?！？()（）"'`]/g, "");
}
function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}
// 两条 note 是否近重复：归一后相等，或较短的(够长)被较长的包含
function _similarNote(a, b) {
  const x = _norm(a);
  const y = _norm(b);
  if (!x || !y) {
    return false;
  }
  if (x === y) {
    return true;
  }
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

export class NotesBackend {
  /** @param {object} [opts] { workspace: WorkspaceBackend(getRoot) } */
  constructor({ workspace } = {}) {
    this._workspace = workspace || null;
  }

  _root(ctx) {
    try {
      return (this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx)) || null;
    } catch {
      return null;
    }
  }

  _file(ctx) {
    const root = this._root(ctx);
    return root ? PathUtils.join(root, FILE) : null;
  }

  /** 当前标签页域名（站点 key）。取不到返回 ""。 */
  currentSite(ctx) {
    try {
      const win = agentWin(ctx);
      const uri = win && win.gBrowser && win.gBrowser.selectedBrowser && win.gBrowser.selectedBrowser.currentURI;
      const host = uri && uri.host;
      if (!host) return "";
      // 归一到主域（去 www / 多级子域只留末两段，便于按站点聚合）
      const parts = host.split(".").filter(Boolean);
      return parts.length > 2 ? parts.slice(-2).join(".") : host;
    } catch {
      return "";
    }
  }

  async _readAll(ctx) {
    const f = this._file(ctx);
    if (!f) return [];
    let text;
    try {
      text = await IOUtils.readUTF8(f);
    } catch {
      return []; // 还没有笔记
    }
    const out = [];
    for (const ln of text.split("\n")) {
      if (!ln.trim()) continue;
      try {
        out.push(JSON.parse(ln));
      } catch {
        /* skip 坏行 */
      }
    }
    return out;
  }

  /**
   * 记一条**验证通过**的进展笔记（append 一行）。只有跑通/对比一致的结论才该调用。
   * @param {object} p { note(必填), site?, topic?, kind?, verifiedBy? }
   */
  async add({ note, site, topic, kind, verifiedBy } = {}, ctx) {
    if (!note || !String(note).trim()) {
      throw new Error("note 必填（一句话写清结论：突破点/坑/算法/指纹依赖等）。");
    }
    const f = this._file(ctx);
    if (!f) {
      throw new Error("未设工作目录：笔记要落到 <工作目录>/.frx-notes.ndjson，请先「打开目录」。");
    }
    const k = KINDS.includes(kind) ? kind : "note";
    const rec = {
      date: new Date().toISOString().slice(0, 10),
      site: (site || this.currentSite(ctx) || "").trim(),
      topic: (topic || "").trim(),
      kind: k,
      status: "verified", // 只记验证过的；写进来即视为已确认可行
      note: String(note).trim().slice(0, 600),
      ...(verifiedBy ? { verifiedBy: String(verifiedBy).trim().slice(0, 300) } : {}),
    };
    // 读全量 → 去重(同 site+kind 近重复丢弃旧的) → 加新条 → 每站封顶(优先级+时间淘汰) → 整体重写。
    // 防"疯狂 notes_add"把文件撑爆；笔记文件小，全量重写开销可忽略。
    let all = await this._readAll(ctx);
    let dedup = 0;
    all = all.filter(r => {
      if (r.site === rec.site && r.kind === rec.kind && _similarNote(r.note, rec.note)) {
        dedup++;
        return false; // 丢弃近重复的旧条，用新条(日期更新)取代
      }
      return true;
    });
    all.push(rec);
    let evicted = 0;
    const siteCount = all.filter(r => r.site === rec.site).length;
    if (siteCount > PER_SITE_CAP) {
      const dropN = siteCount - PER_SITE_CAP;
      // 候选：本站、且非刚加的 rec；按 (优先级升序, 日期升序) 排 → 取最该淘汰的前 dropN 条
      const cand = all
        .filter(r => r.site === rec.site && r !== rec)
        .sort(
          (a, b) =>
            (KIND_PRIORITY[a.kind] || 1) - (KIND_PRIORITY[b.kind] || 1) ||
            String(a.date).localeCompare(String(b.date))
        );
      const toDrop = new Set(cand.slice(0, dropN));
      all = all.filter(r => !toDrop.has(r));
      evicted = toDrop.size;
    }
    await IOUtils.writeUTF8(f, all.map(r => JSON.stringify(r)).join("\n") + "\n");
    return {
      ok: true,
      saved: rec,
      file: f,
      ...(dedup ? { dedupedOld: dedup } : {}),
      ...(evicted ? { evicted } : {}),
      note: `已记入进展笔记（验证过的结论）${dedup ? `；去重 ${dedup} 条旧的` : ""}${evicted ? `；本站超 ${PER_SITE_CAP} 条，淘汰 ${evicted} 条最旧/最低优先级` : ""}。下次逆向同站点会自动提示。`,
    };
  }

  /**
   * 读笔记。默认按当前站点过滤，最近 limit 条。
   * @param {object} p { site?, limit?, all? }
   */
  async get({ site, limit = 30, all } = {}, ctx) {
    const recs = await this._readAll(ctx);
    const key = all ? "" : (site != null ? site : this.currentSite(ctx));
    const hit = key ? recs.filter(r => r.site && String(r.site).includes(key)) : recs;
    const out = hit.slice(-Math.max(1, limit | 0));
    return {
      ok: true,
      file: this._file(ctx),
      site: key || "(all)",
      count: out.length,
      total: recs.length,
      notes: out,
      note: out.length
        ? "历史进展笔记（验证过的）。⚠ 站点会改版，仅供参考，用前先验证。"
        : "该站点暂无历史笔记。",
    };
  }

  /**
   * 生成当前站点的紧凑摘要文本（供每轮注入系统提示）。无笔记/无工作目录→返回 ""。
   * @param {object} p { site?, maxChars?, maxItems? }
   */
  async digest({ site, maxChars = 1800, maxItems = 15 } = {}, ctx) {
    const key = site != null ? site : this.currentSite(ctx);
    if (!key) return "";
    const recs = await this._readAll(ctx);
    const hit = recs.filter(r => r.site && String(r.site).includes(key)).slice(-maxItems);
    if (!hit.length) return "";
    const lines = hit.map(r => `- [${r.date}|${r.kind}] ${r.note}${r.verifiedBy ? `（验证:${r.verifiedBy}）` : ""}`);
    let body = lines.join("\n");
    if (body.length > maxChars) body = body.slice(0, maxChars) + "\n…(更多见 notes_get)";
    return (
      `【历史进展笔记 · 站点 ${key}】（验证过的突破点/坑；⚠ 站点常改版，仅供参考，动手前先验证是否仍适用）\n` +
      body
    );
  }
}
