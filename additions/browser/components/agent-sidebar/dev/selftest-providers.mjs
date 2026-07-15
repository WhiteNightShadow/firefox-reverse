/* dev/selftest-providers.mjs — Node 下验证 providers.sys.mjs 的动态模型拉取与 URL 规范化。
 *   node dev/selftest-providers.mjs
 * 用本地 mock HTTP server 覆盖：无版本段 /v1/models、带版本段 /models（dashscope/zhipu 形态）、
 * 401 报 Key、文档页(HTML 404) 报多候选失败、误贴完整 chat 端点的剥离。不随 omni.ja 打包。
 */
import http from "node:http";
import {
  fetchModels,
  normalizeBaseUrl,
  resolveChatPath,
  buildClientFromStore,
} from "../modules/providers.sys.mjs";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";

let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: got=${JSON.stringify(got)}${ok ? "" : " want=" + JSON.stringify(want)}`);
  if (!ok) {
    fail++;
  }
}

// ---- 纯函数 ----
check("normalize 去尾斜杠", normalizeBaseUrl("https://a.com/v1///"), "https://a.com/v1");
check("normalize 剥 chat/completions", normalizeBaseUrl("https://a.com/compatible-mode/v1/chat/completions"), "https://a.com/compatible-mode/v1");
check("normalize 剥 messages", normalizeBaseUrl("https://a.com/v1/messages"), "https://a.com/v1");
check("normalize 剥 models", normalizeBaseUrl("https://a.com/v1/models"), "https://a.com/v1");
check("chatPath 无版本段", resolveChatPath("openai", "https://api.deepseek.com"), "/v1/chat/completions");
check("chatPath 带 /v1", resolveChatPath("openai", "https://dashscope.aliyuncs.com/compatible-mode/v1"), "/chat/completions");
check("chatPath 带 /v4", resolveChatPath("openai", "https://open.bigmodel.cn/api/paas/v4"), "/chat/completions");
check("chatPath anthropic 带 /v1", resolveChatPath("anthropic", "https://gw.example.com/v1"), "/messages");
check("chatPath anthropic 无版本段", resolveChatPath("anthropic", "https://gw.example.com"), "/v1/messages");
check("chatPath gemini 兼容根 /v1beta/openai", resolveChatPath("openai", "https://generativelanguage.googleapis.com/v1beta/openai"), "/chat/completions");
check("chatPath /v1beta 结尾", resolveChatPath("openai", "https://gw.example.com/v1beta"), "/chat/completions");
check("chatPath host 含 v1 不误判", resolveChatPath("openai", "https://v1.example.com"), "/v1/chat/completions");

// ---- buildClientFromStore：custom + 带版本段 baseUrl 不再叠 /v1 ----
const cs = new ConfigStore();
cs.setActiveProvider("custom");
cs.setCustomBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/");
cs.setCustomProtocol("openai");
cs.setModel("custom", "qwen3-max");
const client = buildClientFromStore(cs);
check("custom chat URL 不翻倍", client.baseUrl + client.chatPath, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
let requestBody = JSON.parse(client.buildRequest([{ role: "user", content: "hi" }]).init.body);
check("custom reasoning 默认不发字段", requestBody.reasoning_effort, undefined);
check("custom reasoning 默认保留 temperature", requestBody.temperature, 0.7);

cs.setCustomReasoningEffort("high");
const reasoningClient = buildClientFromStore(cs);
requestBody = JSON.parse(reasoningClient.buildRequest([{ role: "user", content: "hi" }]).init.body);
check("custom reasoning high 写入请求", requestBody.reasoning_effort, "high");
check("显式 reasoning 不发 temperature", requestBody.temperature, undefined);

const overrideClient = buildClientFromStore(cs, { reasoningEffort: "xhigh" });
requestBody = JSON.parse(overrideClient.buildRequest([{ role: "user", content: "hi" }]).init.body);
check("reasoning override 优先", requestBody.reasoning_effort, "xhigh");

cs.setCustomProtocol("anthropic");
const anthropicClient = buildClientFromStore(cs);
requestBody = JSON.parse(anthropicClient.buildRequest([{ role: "user", content: "hi" }]).init.body);
check("Anthropic 不误发 OpenAI reasoning_effort", requestBody.reasoning_effort, undefined);
cs.setCustomProtocol("openai");

// ---- mock server ----
const MODELS = { data: [{ id: "m-alpha" }, { id: "m-beta" }] };
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  // 站点 A：标准 OpenAI 形态，只有 /v1/models
  if (req.url === "/a/v1/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MODELS));
  }
  // 站点 B：dashscope/zhipu 形态，base 带版本段，端点 = {base}/models
  if (req.url === "/b/compatible-mode/v1/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MODELS));
  }
  // 站点 C：要鉴权，无 key → 401
  if (req.url === "/c/v1/models") {
    if (auth !== "Bearer good-key") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "invalid api key" }));
    }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MODELS));
  }
  // 站点 D：gemini 兼容根形态（版本段后还有后缀），端点 = {base}/models
  if (req.url === "/d/v1beta/openai/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MODELS));
  }
  // 站点 E：Anthropic 风格，只认 x-api-key 不认 Bearer
  if (req.url === "/e/v1/models") {
    if (req.headers["x-api-key"] !== "good-key") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "x-api-key required" }));
    }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MODELS));
  }
  // 其余：模拟文档站，404 + HTML
  res.statusCode = 404;
  res.setHeader("content-type", "text/html");
  res.end("<html><body>not found</body></html>");
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

check("无版本段 → /v1/models", await fetchModels(`${origin}/a`), ["m-alpha", "m-beta"]);
check("带版本段 → {base}/models", await fetchModels(`${origin}/b/compatible-mode/v1`), ["m-alpha", "m-beta"]);
check("误贴完整 chat 端点也能拉", await fetchModels(`${origin}/b/compatible-mode/v1/chat/completions`), ["m-alpha", "m-beta"]);
check("带 key 通过鉴权", await fetchModels(`${origin}/c`, "good-key"), ["m-alpha", "m-beta"]);
check("gemini 兼容根 → 首选 {base}/models", await fetchModels(`${origin}/d/v1beta/openai`), ["m-alpha", "m-beta"]);
check("Anthropic 风格 x-api-key 鉴权", await fetchModels(`${origin}/e`, "good-key"), ["m-alpha", "m-beta"]);

async function errOf(p) {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    return e.message;
  }
}
const e401 = await errOf(fetchModels(`${origin}/c`, "bad-key"));
check("401 → 报 Key 问题", /API Key 无效/.test(e401), true);
const eDocs = await errOf(fetchModels(`${origin}/zh/model-studio/more-tools`));
check("文档页 → 列出全部尝试", /已尝试/.test(eDocs) && /v1\/models/.test(eDocs), true);
check("文档页 → 提示疑似网页", /网页/.test(eDocs), true);
const eEmpty = await errOf(fetchModels(""));
check("空 URL 提示", eEmpty, "请先填写 Base URL");
const eScheme = await errOf(fetchModels("help.aliyun.com/zh"));
check("缺协议头提示", /http/.test(eScheme), true);

server.close();
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
