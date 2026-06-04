/* dev/selftest-stream.mjs — LlmClient._readStream SSE 解析自测（mock 流，无需 key/网络）。
 *   node dev/selftest-stream.mjs
 */
import { LlmClient } from "../modules/LlmClient.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.error("  ✗ FAIL:", m)));

const c = new LlmClient({ baseUrl: "https://x", apiKey: "k", model: "deepseek-chat" });

// 构造 mock SSE 响应：两段正文 + 分片 tool_call + finish
const sse =
  [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"code_search","arguments":"{\\"que"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"sign\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":42}}',
    "data: [DONE]",
  ].join("\n") + "\n";

const bytes = new TextEncoder().encode(sse);
let served = false;
const resp = {
  body: {
    getReader() {
      return {
        read() {
          if (!served) {
            served = true;
            return Promise.resolve({ done: false, value: bytes });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  },
};

const deltas = [];
const res = await c._readStream(resp, ch => deltas.push(ch));

ok(res.content === "你好，世界", `正文累积: "${res.content}"`);
ok(deltas.length === 2 && deltas.join("") === "你好，世界", `onDelta 增量回调 ${deltas.length} 次`);
ok(res.toolCalls.length === 1, "tool_calls 累积为 1 条");
ok(res.toolCalls[0].function.name === "code_search", "tool_call name 拼接正确");
ok(res.toolCalls[0].function.arguments === '{"query":"sign"}', `tool_call arguments 分片拼接正确: ${res.toolCalls[0].function.arguments}`);
ok(res.finishReason === "tool_calls", "finish_reason 解析");
ok(res.usage && res.usage.total_tokens === 42, "usage 解析");

// 边界：分块到达（value 被切成两半）也应正确
served = false;
const half = Math.floor(bytes.length / 2);
let part = 0;
const resp2 = {
  body: {
    getReader() {
      return {
        read() {
          if (part === 0) { part = 1; return Promise.resolve({ done: false, value: bytes.slice(0, half) }); }
          if (part === 1) { part = 2; return Promise.resolve({ done: false, value: bytes.slice(half) }); }
          return Promise.resolve({ done: true });
        },
      };
    },
  },
};
const res2 = await c._readStream(resp2, () => {});
ok(res2.content === "你好，世界", "跨网络分块边界仍正确累积");

console.log(`\n流式解析自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
