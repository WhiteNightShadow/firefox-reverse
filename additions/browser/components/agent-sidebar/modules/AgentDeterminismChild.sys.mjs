/* AgentDeterminismChild.sys.mjs — page_determinism 的内容侧。
 *
 * DOMWindowCreated 在新文档的 global 建好、页面脚本还没跑时触发：按 sharedData 里的配置（PageDeterminism
 * 写入，新开的内容进程启动时也会带上）给这个文档设种子，所以跨进程导航后的第一个文档同样是确定的。
 * start/stop 时父进程再发 Determinism:Seed 给已经存在的文档补设或撤销（seed 为空串）。
 */
const CONFIG_KEY = "agentsidebar:determinism"; // 与 PageDeterminism.sys.mjs 同一个键

export class AgentDeterminismChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== "DOMWindowCreated") return;
    let config;
    try {
      config = Services.cpmm.sharedData.get(CONFIG_KEY);
    } catch {
      return;
    }
    if (config?.seed && (config.scope === "all" || this.browsingContext.browserId === config.browserId)) {
      this.seed(config.seed);
    }
  }

  receiveMessage({ name, data }) {
    if (name === "Determinism:Seed") return this.seed(String(data?.seed ?? ""));
    return null;
  }

  seed(seed) {
    try {
      ChromeUtils.setDeterministicRandom(this.contentWindow, seed);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
}
