/* dev/selftest-anthropic.mjs — Anthropic 协议适配器自测（Node，无网络）。
 * 验证 OpenAI 形态消息 → Anthropic /v1/messages 的翻译 + 响应解析。
 *   node dev/selftest-anthropic.mjs
 */
import { LlmClient, toAnthropicMessages } from "../modules/LlmClient.sys.mjs";

let pass = 0,
  fail = 0;
const ok = (c, m) => {
  if (c) {
    pass++;
    console.log("  ✓", m);
  } else {
    fail++;
    console.error("  ✗ FAIL:", m);
  }
};

console.log("[1] toAnthropicMessages 翻译 + 连续 tool_result 合并");
const { system, messages } = toAnthropicMessages([
  { role: "system", content: "sys1" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "page_info", arguments: '{"a":1}' } }] },
  { role: "tool", tool_call_id: "t1", content: '{"ok":true}' },
  { role: "tool", tool_call_id: "t1b", content: '{"ok":false}' },
  { role: "assistant", content: "done" },
]);
ok(system === "sys1", "system 提取");
ok(messages.length === 4, "消息数=4（连续 tool_result 合并进一个 user）: " + messages.length);
ok(messages[0].role === "user" && messages[0].content[0].type === "text", "首条 user text");
ok(
  messages[1].role === "assistant" &&
    messages[1].content.some(b => b.type === "tool_use" && b.name === "page_info" && b.input.a === 1),
  "assistant tool_use + input JSON 解析"
);
ok(messages[2].role === "user" && messages[2].content.filter(b => b.type === "tool_result").length === 2, "两条 tool_result 合并到一个 user");
ok(messages[3].role === "assistant" && messages[3].content[0].text === "done", "末 assistant text");

console.log("[2] vision 图文 user 块翻译");
const v = toAnthropicMessages([
  { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
]);
const ub = v.messages[0].content;
ok(
  ub[0].type === "text" && ub[1].type === "image" && ub[1].source.type === "base64" && ub[1].source.media_type === "image/png" && ub[1].source.data === "QUJD",
  "image_url dataURL → anthropic image(base64)"
);

console.log("[3] buildRequest(anthropic)");
const c = new LlmClient({ protocol: "anthropic", baseUrl: "http://h:8080", apiKey: "k1", model: "m1" });
const { url, init } = c.buildRequest([{ role: "user", content: "hi" }], {
  tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }],
});
ok(url === "http://h:8080/v1/messages", "URL=/v1/messages: " + url);
ok(init.headers["anthropic-version"] && init.headers["x-api-key"] === "k1" && init.headers.Authorization === "Bearer k1", "headers x-api-key + Bearer + anthropic-version");
const body = JSON.parse(init.body);
ok(body.model === "m1" && body.max_tokens > 0 && Array.isArray(body.messages), "body model/max_tokens/messages");
ok(body.temperature === undefined, "anthropic 不发 temperature（新 Claude 模型已弃用，发了会 400）");
ok(body.tools[0].name === "f" && body.tools[0].input_schema && !body.tools[0].parameters, "tools → input_schema(去掉 parameters)");

console.log("[4] parseResponse(anthropic)");
const r = c.parseResponse({
  content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "u1", name: "f", input: { x: 1 } }],
  stop_reason: "tool_use",
  usage: { output_tokens: 5 },
});
ok(r.content === "hello", "text 块 → content");
ok(r.toolCalls.length === 1 && r.toolCalls[0].function.name === "f" && JSON.parse(r.toolCalls[0].function.arguments).x === 1, "tool_use → OpenAI 形 toolCalls");
ok(r.finishReason === "tool_use", "stop_reason → finishReason");

console.log(`\nAnthropic 适配自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
