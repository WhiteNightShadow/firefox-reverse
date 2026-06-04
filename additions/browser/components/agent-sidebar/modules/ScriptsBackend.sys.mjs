/* ScriptsBackend.sys.mjs — 存JS：抓页面脚本源码落盘到语料目录（= 搜索的语料）。
 *
 * list(): 用 PageBackend 在页面里枚举脚本 URL（document.scripts + resource timing）。
 * save(): parent 特权 fetch（绕过 CORS）拿源码 → IOUtils 写到 <profile>/firefox-reverse-agent/js/。
 */

// parent/system-ESM 无 window，AbortSignal.timeout 不可用；从 Timer.sys.mjs 取 setTimeout。
const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

function sanitize(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
// 没有扩展名才补 .js（避免 url 已含 ".js" 时 +".js" → ".js.js" 双扩展名 bug）。
function withExt(name) {
  return /\.[a-zA-Z0-9]{1,6}$/.test(name) ? name : name + ".js";
}
// 取 URL 的 basename 作**短**文件名（可预测、Agent 不必手敲整条 URL 转成的长串、也不会敲漏）。
function shortNameFromUrl(url) {
  let base = "";
  try {
    base = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    /* 非法 URL → 兜底 */
  }
  if (!base) {
    base = sanitize(url).split("_").filter(Boolean).pop() || "script";
  }
  return withExt(base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80));
}

export class ScriptsBackend {
  constructor({ page, workspace } = {}) {
    this.page = page;
    this._workspace = workspace || null;
  }

  async corpusDir() {
    const dir = PathUtils.join(PathUtils.profileDir, "firefox-reverse-agent", "js");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    return dir;
  }

  /** 工作目录根（未设则 null）。**必须传 ctx**：getRoot(ctx) 优先 ctx.workspaceRoot（会话级隔离），
   *  否则退回全局根——而全局根会被另一个并发会话覆盖 → 落盘串到别的任务目录（实测 mihuashi 的 scripts_save
   *  落进了头条ab 的目录）。 */
  _wsRoot(ctx) {
    try {
      return (this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx)) || null;
    } catch {
      return null;
    }
  }

  /** 短名 → 完整 URL。Agent 常从 initiatorStack/scripts_list 拿到的是短名(如 index.Dy4x2G-f.js)，
   *  直接 fetch 短名会 "is not a valid URL"。这里按 basename 在**页面已加载脚本**里匹配回完整 URL。 */
  async _resolveUrl(url) {
    if (/^(https?|data|blob|file|chrome|resource|moz-extension):/i.test(url)) {
      return url; // 已是完整 URL/可 fetch 的协议
    }
    const base = String(url).split(/[\\/]/).pop();
    let urls = [];
    try {
      const r = await this.list(); // 页面已加载脚本(含 performance 资源里的动态 import chunk)
      urls = Array.isArray(r?.urls) ? r.urls : [];
    } catch {
      /* 页面取不到就走下面的报错 */
    }
    const baseOf = u => {
      try {
        return new URL(u).pathname.split("/").filter(Boolean).pop() || "";
      } catch {
        return String(u).split(/[?#]/)[0].split(/[\\/]/).pop() || "";
      }
    };
    const cands = urls.filter(u => baseOf(u) === base);
    if (cands.length === 1) {
      return cands[0];
    }
    if (cands.length > 1) {
      throw new Error(
        `短名「${url}」匹配到 ${cands.length} 个已加载脚本，分不清。请用完整 URL 之一：\n` + cands.slice(0, 8).join("\n")
      );
    }
    throw new Error(
      `「${url}」不是有效 URL，也没在页面已加载脚本里按文件名匹配到。` +
        `用 scripts_list 看实际 URL 再传完整 https:// 地址（initiatorStack 里的短名不能直接当 url）。`
    );
  }

  /** 枚举当前页面加载的脚本 URL。 */
  async list() {
    if (!this.page) {
      throw new Error("ScriptsBackend 需要 page backend");
    }
    const r = await this.page.eval({
      expression:
        "Array.from(new Set(Array.from(document.scripts).map(s=>s.src).filter(Boolean)" +
        ".concat(performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script'||/\\.js(\\?|$)/.test(e.name)).map(e=>e.name))))",
    });
    const urls = Array.isArray(r?.value) ? r.value : [];
    return { ok: true, count: urls.length, urls };
  }

  /**
   * 抓单个脚本源码落盘。
   * @param {object} p { url, path?, toWorkspace? }
   *   toWorkspace=true → 存到 <工作目录>/scripts/（**立即可 run_node 执行**，用于 signer 落地补环境）；
   *   否则存语料目录（供 code_search / 离线分析）。
   */
  async save({ url, path, toWorkspace, force } = {}, ctx) {
    if (!url) {
      throw new Error("url required");
    }
    url = await this._resolveUrl(url); // 短名 → 完整 URL（避免 "is not a valid URL"）
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000); // 单个 8s 超时
    let resp;
    try {
      resp = await fetch(url, { signal: ac.signal }); // 特权 fetch 绕 CORS
    } finally {
      clearTimeout(timer);
    }
    // 二进制判定：.wasm/.bin 等扩展名 或 响应 content-type 非文本 → 走二进制路径（arrayBuffer + 原始字节写）。
    // 之前对 .wasm 用 resp.text()+writeUTF8 → UTF-8 编解码破坏二进制字节（字节数被改变、wasm magic 校验失败、
    // 实例化崩溃，逼模型绕路）。二进制必须读字节、写字节，绝不经文本。
    const ctype = (safe(() => resp.headers.get("content-type")) || "").toLowerCase();
    const isBinary =
      /\.(wasm|bin|so|dylib|dll|png|jpg|jpeg|gif|webp|woff2?|ttf|otf|ico|pdf|zip|gz)(\?|$)/i.test(url) ||
      /application\/wasm|application\/octet-stream|^image\/|^font\/|^audio\/|^video\//.test(ctype);
    const httpBad = !(resp.status >= 200 && resp.status < 300);

    if (isBinary) {
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (httpBad && !force) {
        return { ok: false, url, httpStatus: resp.status, bytes: bytes.length,
          error: `拒绝落盘：HTTP ${resp.status}（二进制资源抓取失败）。换可用 URL 或确认资源存在。` };
      }
      // 二进制完整性轻校验：wasm magic = \0asm。落盘后回报字节数 + magic，便于模型确认没落坏。
      const isWasm = /\.wasm(\?|$)/i.test(url) || /application\/wasm/.test(ctype);
      const magicOk = !isWasm || (bytes.length > 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d);
      let out, rel;
      if (toWorkspace) {
        const root = this._wsRoot(ctx);
        if (!root) {
          throw new Error("toWorkspace 需先设工作目录（侧边栏「打开目录」）。");
        }
        // 二进制按用途落 wasm/（与 wasm_disasm/wasm_probe 约定一致）；其它二进制也落 wasm/ 兜底。
        const sub = /\.wasm(\?|$)/i.test(url) ? "wasm" : "scripts";
        const dir = PathUtils.join(root, sub);
        await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
        const raw = path && !PathUtils.isAbsolute(path) ? path : shortNameFromUrl(url);
        const fname = raw.split(/[\\/]/).pop() || "blob.bin";
        out = PathUtils.join(dir, fname);
        rel = sub + "/" + fname;
      } else {
        const dir = await this.corpusDir();
        const name = path || sanitize(url);
        out = PathUtils.isAbsolute(name) ? name : PathUtils.join(dir, name);
        rel = out;
      }
      await IOUtils.write(out, bytes); // 原始字节写，不经文本编码
      return {
        ok: true, url, path: out, ...(toWorkspace ? { workspaceRelative: rel } : {}),
        bytes: bytes.length, binary: true, magicOk,
        note: `已落盘二进制 ${bytes.length} 字节${isWasm ? `（wasm magic ${magicOk ? "✓" : "✗ 可能损坏"}）` : ""}。` +
          (toWorkspace ? `后续用相对路径 \`${rel}\`（传给 wasm_probe/wasm_disasm）。` : ""),
      };
    }

    const text = await resp.text();
    // A4 产物完整性①：拒绝把"错误残片"当脚本落盘。CDN 某 key 404 常返回几百字节的
    // {"code":"NoSuchKey",...} / 短 HTML 错误页；落盘会覆盖掉之前抓到的好文件（实测 254KB→260B 事故）。
    const looksError =
      text.length < 1024 &&
      /(NoSuchKey|key.?not.?exist|<Error>|"code"\s*:\s*"[A-Za-z]*Error|Access ?Denied|404 Not Found|The specified key does not exist)/i.test(text);
    if ((httpBad || looksError) && !force) {
      return {
        ok: false,
        url,
        httpStatus: resp.status,
        bytes: text.length,
        error:
          `拒绝落盘：抓到的疑似**错误残片**（HTTP ${resp.status}，${text.length} 字节${looksError ? "，含 404/NoSuchKey 特征" : ""}），` +
          `不是有效脚本。**绝不能用它覆盖已抓到的好文件。** 这个 CDN key 多半已失效——改从**浏览器已加载的脚本源码**取（scripts_list 找实际加载的 URL，或换其它可用 CDN 域），别重抓这个 404 URL。`,
      };
    }
    if (toWorkspace) {
      const root = this._wsRoot(ctx);
      if (!root) {
        throw new Error("toWorkspace 需先设工作目录（侧边栏「打开目录」）。");
      }
      const dir = PathUtils.join(root, "scripts");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      // 默认用 URL 的 basename（短、可预测）；Agent 也可传 path 指定短名。只取 basename 防路径穿越。
      const raw = path && !PathUtils.isAbsolute(path) ? path : shortNameFromUrl(url);
      const fname = raw.split(/[\\/]/).pop() || "script.js";
      const out = PathUtils.join(dir, fname);
      // A4 产物完整性②：若目标已存在且**远大于**新内容（>10×）→ 默认拒绝覆盖（疑似用残片覆盖好文件）。
      if (!force) {
        try {
          const st = await IOUtils.stat(out);
          if (st && st.size > 0 && st.size > text.length * 10 && text.length < 8192) {
            return {
              ok: false,
              url,
              path: out,
              existingBytes: st.size,
              newBytes: text.length,
              error:
                `拒绝覆盖：已存在 \`scripts/${fname}\`（${st.size} 字节），新抓到的只有 ${text.length} 字节（小 10 倍以上），` +
                `极可能是用残片覆盖好文件。已保留旧文件。确认要覆盖才传 \`force:true\`；通常你该直接用已落盘的好文件。`,
            };
          }
        } catch {
          /* 不存在 → 正常落盘 */
        }
      }
      await IOUtils.writeUTF8(out, text);
      const rel = "scripts/" + fname;
      return {
        ok: true,
        url,
        path: out,
        workspaceRelative: rel,
        bytes: text.length,
        note: `已落盘。后续 fs_read / run_node / 传给 wasm_probe 一律用这个相对路径：\`${rel}\`——从这里**原样复制**，别手敲长文件名（敲漏会"文件不存在"）。`,
      };
    }
    const dir = await this.corpusDir();
    const name = path || withExt(sanitize(url));
    const out = PathUtils.isAbsolute(name) ? name : PathUtils.join(dir, name);
    await IOUtils.writeUTF8(out, text);
    return { ok: true, url, path: out, bytes: text.length };
  }

  /** 抓当前页面所有外部脚本到语料目录（并发，避免大站 191 脚本串行超时）。 */
  async captureAll({ concurrency = 12 } = {}) {
    const { urls } = await this.list();
    const saved = [];
    const failed = [];
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const u = urls[idx++];
        try {
          const r = await this.save({ url: u });
          saved.push({ url: u, path: r.path, bytes: r.bytes });
        } catch (e) {
          failed.push({ url: u, error: String((e && e.message) || e) });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker)
    );
    return {
      ok: true,
      total: urls.length,
      savedCount: saved.length,
      failedCount: failed.length,
      saved: saved.slice(0, 60),
      failed: failed.slice(0, 20),
    };
  }
}
