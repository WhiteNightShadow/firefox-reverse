import {
  cacheHitRate,
  mergeUsage,
  normalizeUsage,
} from "../modules/Usage.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};

const openai = normalizeUsage({
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 20 },
}, { provider: "custom", protocol: "openai" });
ok(openai.inputTokens === 1000 && openai.uncachedInputTokens === 400, "OpenAI cached_tokens normalized");
ok(openai.outputTokens === 100 && openai.reasoningTokens === 20, "OpenAI output/reasoning normalized");

const deepseek = normalizeUsage({
  prompt_tokens: 1000,
  completion_tokens: 80,
  prompt_cache_hit_tokens: 700,
  prompt_cache_miss_tokens: 300,
}, { provider: "deepseek", protocol: "openai" });
ok(deepseek.cacheReadTokens === 700 && deepseek.cacheMissTokens === 300, "DeepSeek hit/miss normalized");

const anthropic = normalizeUsage({
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 200,
}, { provider: "custom", protocol: "anthropic" });
ok(anthropic.inputTokens === 800 && anthropic.uncachedInputTokens === 100, "Anthropic logical input normalized");
ok(anthropic.cacheReadTokens === 500 && anthropic.cacheWriteTokens === 200, "Anthropic cache read/write normalized");

const total = mergeUsage(openai, deepseek, anthropic);
ok(total.requests === 3 && total.inputTokens === 2800, "usage aggregation sums requests and input");
ok(Math.abs(cacheHitRate(total) - 1800 / 2800) < 0.0001, "cache hit rate uses logical input");
ok(normalizeUsage(null).requests === 0, "missing provider usage is safely ignored");

console.log(`\nUsage selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
