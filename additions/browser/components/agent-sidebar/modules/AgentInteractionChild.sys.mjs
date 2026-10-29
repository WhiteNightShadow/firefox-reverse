import { PageInteractionCore } from "./PageInteractionCore.sys.mjs";

export class AgentInteractionChild extends JSWindowActorChild {
  async receiveMessage({ name, data }) {
    if (name !== "interact") return null;
    try {
      if (!this.contentWindow || this.document.nodePrincipal.isSystemPrincipal) throw new Error("unsupported_document");
      this.core ||= new PageInteractionCore(this.contentWindow);
      const { action, ...args } = data || {};
      return action === "snapshot" || action === "find" ? this.core.scan(args) : await this.core.act(action, args);
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }
}
