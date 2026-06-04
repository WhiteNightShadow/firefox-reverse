/* dev/selftest-e2e.mjs — 端到端：ConfigStore → buildClientFromStore → DeepSeek。
 * 验证「配置存取 → 构造 client → 真实调用」整链，而不只是 LlmClient 单点。
 *
 *   node dev/selftest-e2e.mjs                          # dry-run
 *   DEEPSEEK_API_KEY=sk-xxx node dev/selftest-e2e.mjs --live
 */
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { buildClientFromStore } from "../modules/providers.sys.mjs";

const live = process.argv.includes("--live");

// 模拟用户在 SettingsPane 的操作：选 provider、填 key
const store = new ConfigStore(); // Node 下内存 backend
store.setActiveProvider("deepseek");
store.setApiKey("deepseek", process.env.DEEPSEEK_API_KEY || "(none)");
// 不设 model → 应回退 provider.defaultModel

const client = buildClientFromStore(store);
console.log("构造结果: provider=deepseek model=%s endpoint=%s", client.model, client.endpoint);
if (client.model !== "deepseek-v4-pro") {
  console.error("FAIL: 期望回退到 defaultModel=deepseek-v4-pro");
  process.exit(1);
}

const messages = [
  { role: "system", content: "你是 firefox-reverse 内置逆向助手。" },
  { role: "user", content: "只回一个字：好" },
];

if (!live) {
  const { url } = client.buildRequest(messages);
  console.log("DRY RUN OK：would POST", url);
  process.exit(0);
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("--live 需要 DEEPSEEK_API_KEY");
  process.exit(1);
}

try {
  const res = await client.chat(messages);
  console.log("content:", res.content);
  console.log("usage:", res.usage?.total_tokens, "tokens");
  console.log("\nE2E PASS（ConfigStore → providers → LlmClient → DeepSeek 全链路）");
} catch (e) {
  console.error("E2E FAIL:", e.message, e.status ? `(status ${e.status})` : "");
  if (e.body) {
    console.error("body:", e.body);
  }
  process.exit(1);
}
