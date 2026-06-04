/* dev/selftest-llm.mjs — 在 Node 下独立验证 LlmClient，无需编译 Firefox。
 *
 * 用法：
 *   node dev/selftest-llm.mjs                  # dry-run：构造并打印请求，不发送
 *   DEEPSEEK_API_KEY=sk-xxx \
 *     node dev/selftest-llm.mjs --live "你好"  # 真发：需 DEEPSEEK_API_KEY
 *
 * 这是开发期验证脚本，不随 omni.ja 打包（由 jar.mn 排除 dev/）。
 */
import { LlmClient } from "../modules/LlmClient.sys.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const prompt = args.find((a) => !a.startsWith("--")) || "用一句话自我介绍";

const client = new LlmClient({
  protocol: "openai",
  baseUrl: "https://api.deepseek.com",
  chatPath: "/v1/chat/completions",
  apiKey: process.env.DEEPSEEK_API_KEY || "(dry-run-no-key)",
  model: "deepseek-chat",
});

const messages = [
  { role: "system", content: "你是 firefox-reverse 浏览器内置的 JS 逆向助手。" },
  { role: "user", content: prompt },
];

if (!live) {
  const { url, init } = client.buildRequest(messages);
  const shownHeaders = { ...init.headers, Authorization: "Bearer ***redacted***" };
  console.log("=== DRY RUN（不发送请求）===");
  console.log("POST", url);
  console.log("headers:", shownHeaders);
  console.log("body:", JSON.stringify(JSON.parse(init.body), null, 2));
  console.log("\nOK：LlmClient import + buildRequest 正常。");
  console.log("加 --live 且设 DEEPSEEK_API_KEY 可发真实请求。");
  process.exit(0);
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("ERROR: --live 需要环境变量 DEEPSEEK_API_KEY");
  process.exit(1);
}

console.log("=== LIVE：调用 DeepSeek ===");
try {
  const res = await client.chat(messages);
  console.log("content:", res.content);
  console.log("finishReason:", res.finishReason);
  console.log("usage:", res.usage);
} catch (e) {
  console.error("FAILED:", e.message, e.status ? `(status ${e.status})` : "");
  if (e.body) {
    console.error("body:", e.body);
  }
  process.exit(1);
}
