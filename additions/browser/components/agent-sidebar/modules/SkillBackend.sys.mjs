/* SkillBackend.sys.mjs — 返回内置「逆向方法论」全文（skill_get 工具）。
 *
 * 方法论正文随浏览器打进 omni：content/skill-reverse.md（jar.mn 注册）。
 * 系统提示只留短核心；Agent 开工逆向前调 skill_get 把全文拉进上下文（按需、不常驻）。
 * 读法沿用 JsvmpBackend 的 chrome:// 提取：NetUtil.asyncFetch + loadUsingSystemPrincipal。
 */
const SKILL_URL = "chrome://browser/content/agent-sidebar/skill-reverse.md";
// 内置脚手架：skill_get 时释放到 <工作目录>/.agent-tools/templates/，AI 一句 fs_copy 拿现成改。
const TEMPLATES = ["node-env-loader.js", "wasm-signer-loader.js", "request-template.js"];

export class SkillBackend {
  constructor({ workspace } = {}) {
    this._cache = null;
    this._workspace = workspace || null;
  }

  /** 读 chrome:// 内置文本资源（skill 正文 / 模板共用）。 */
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

  /** 把内置脚手架释放到 <工作目录>/.agent-tools/templates/（已存在则跳过）。返回相对路径列表。 */
  async _releaseTemplates(ctx) {
    // **必须传 ctx**：getRoot(ctx) 优先 ctx.workspaceRoot（会话级）；无 ctx 退回全局根，而引擎直驱/多窗口下
    // 全局根可能为空或被别会话覆盖 → 释放失败（root 为空直接 return []）→ 脚手架模板一个都不落 →
    // AI 没现成 loader 可 fs_copy → 从零手写 loader 反复撞 wasm-bindgen 的 unreachable → 掉进字节级逆向兔子洞。
    const root = this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx);
    if (!root) {
      return [];
    }
    const dir = PathUtils.join(root, ".agent-tools", "templates");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    const rels = [];
    for (const name of TEMPLATES) {
      const dest = PathUtils.join(dir, name);
      const rel = ".agent-tools/templates/" + name;
      rels.push(rel);
      try {
        const st = await IOUtils.stat(dest);
        if (st && st.size > 0) {
          continue; // 已释放
        }
      } catch {
        /* 不存在 → 释放 */
      }
      try {
        const text = await this._readChrome("chrome://browser/content/agent-sidebar/templates/" + name);
        await IOUtils.writeUTF8(dest, text);
      } catch {
        /* 单个模板失败不影响其它 */
      }
    }
    return rels;
  }

  async _read() {
    if (this._cache) {
      return this._cache;
    }
    this._cache = await this._readChrome(SKILL_URL);
    return this._cache;
  }

  /** 返回逆向方法论全文 + 释放内置脚手架到工作目录。开工逆向前调一次。 */
  async get(_p, ctx) {
    try {
      const skill = await this._read();
      let templates = [];
      try {
        templates = await this._releaseTemplates(ctx);
      } catch {
        /* 没设工作目录就不释放，不影响正文 */
      }
      return {
        ok: true,
        skill,
        templates,
        note:
          "逆向方法论全文（一页流：决策树→常规执行链 6 步→工具速查）。" +
          (templates.length
            ? `已释放脚手架到工作目录：${templates.join("、")}——补环境/实打接口时 fs_copy 到 work/ 改现成的，别从零写。`
            : "（设了工作目录后再调一次会自动释放 node 补环境/请求脚手架。）"),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}
