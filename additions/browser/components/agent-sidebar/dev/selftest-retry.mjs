/* dev/selftest-retry.mjs — LlmClient 瞬时错误重试自测（Node，mock fetch，无网络）。
 *   node dev/selftest-retry.mjs
 */
import { LlmClient } from "../modules/LlmClient.sys.mjs";

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

const mkClient = () => {
  const c = new LlmClient({ protocol: "openai", baseUrl: "http://x", apiKey: "k", model: "m", request: { timeout_ms: 5000 } });
  c._delay = () => Promise.resolve(); // 测试里不真等
  return c;
};

console.log("[1] 502(upstream) 两次后重试成功");
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls < 3) {
    return { ok: false, status: 502, statusText: "Bad Gateway", text: async () => '{"error":{"type":"upstream_error"}}' };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) };
};
const r = await mkClient().chat([{ role: "user", content: "hi" }]);
ok(calls === 3, `502×2 后第 3 次成功（fetch 调用 ${calls} 次）`);
ok(r.content === "hi", "重试后拿到正常响应");

console.log("[2] 400 不重试（请求错误，重试无意义）");
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return { ok: false, status: 400, statusText: "Bad Request", text: async () => '{"error":{"message":"bad"}}' };
};
let status400 = null;
try {
  await mkClient().chat([{ role: "user", content: "x" }]);
} catch (e) {
  status400 = e.status;
}
ok(status400 === 400 && calls === 1, `400 直接抛、不重试（fetch 调用 ${calls} 次）`);

console.log("[3] 持续 502 → 重试耗尽后抛（带提示）");
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return { ok: false, status: 502, statusText: "Bad Gateway", text: async () => '{"error":{"type":"upstream_error"}}' };
};
let msg = "";
try {
  await mkClient().chat([{ role: "user", content: "x" }]);
} catch (e) {
  msg = e.message;
}
ok(calls === 3 && /重试/.test(msg), `502 重试 3 次后抛、消息含「重试」（fetch ${calls} 次）`);

console.log(`\n重试自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
