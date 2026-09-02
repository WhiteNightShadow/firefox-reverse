/* Usage.sys.mjs - provider-neutral token usage accounting. */

const COUNTER_FIELDS = Object.freeze([
  "requests",
  "inputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheMissTokens",
  "reasoningTokens",
]);

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function emptyUsage() {
  return {
    requests: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    providerReported: false,
  };
}

/** Normalize OpenAI-compatible, DeepSeek, Qwen, and Anthropic usage shapes. */
export function normalizeUsage(raw, meta = {}) {
  const out = {
    ...emptyUsage(),
    provider: String(meta.provider || ""),
    protocol: String(meta.protocol || ""),
    model: String(meta.model || ""),
    phase: String(meta.phase || "chat"),
    at: Number.isFinite(meta.at) ? meta.at : Date.now(),
  };
  if (!raw || typeof raw !== "object") {
    return out;
  }

  out.requests = 1;
  out.providerReported = true;

  const details = raw.prompt_tokens_details || raw.input_tokens_details || {};
  const completionDetails = raw.completion_tokens_details || raw.output_tokens_details || {};
  const explicitRead = count(
    raw.prompt_cache_hit_tokens ??
      raw.cache_read_input_tokens ??
      raw.cache_read_tokens ??
      details.cached_tokens
  );
  const creation = raw.cache_creation || {};
  const explicitWrite = count(
    raw.cache_creation_input_tokens ??
      raw.cache_write_input_tokens ??
      raw.cache_write_tokens ??
      details.cache_write_tokens ??
      (count(creation.ephemeral_5m_input_tokens) +
        count(creation.ephemeral_1h_input_tokens))
  );
  const explicitMiss = count(raw.prompt_cache_miss_tokens ?? raw.cache_miss_tokens);
  const prompt = count(raw.prompt_tokens ?? raw.input_tokens);

  out.cacheReadTokens = explicitRead;
  out.cacheWriteTokens = explicitWrite;
  out.cacheMissTokens = explicitMiss;
  out.outputTokens = count(raw.completion_tokens ?? raw.output_tokens);
  out.reasoningTokens = count(
    raw.reasoning_tokens ?? completionDetails.reasoning_tokens
  );

  // Anthropic input_tokens excludes cache reads/creation. OpenAI-compatible
  // providers generally include cached tokens in prompt_tokens.
  const anthropicShape =
    raw.input_tokens != null &&
    (raw.cache_read_input_tokens != null || raw.cache_creation_input_tokens != null);
  if (anthropicShape) {
    out.uncachedInputTokens = prompt;
    out.inputTokens = prompt + explicitRead + explicitWrite;
    if (!out.cacheMissTokens) {
      out.cacheMissTokens = prompt;
    }
  } else {
    out.inputTokens = prompt;
    out.uncachedInputTokens = explicitMiss || Math.max(0, prompt - explicitRead);
    if (!out.cacheMissTokens) {
      out.cacheMissTokens = out.uncachedInputTokens;
    }
  }
  return out;
}

/** Sum one or more normalized usage records without retaining raw provider data. */
export function mergeUsage(...records) {
  const out = emptyUsage();
  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    for (const field of COUNTER_FIELDS) {
      out[field] += count(record[field]);
    }
    out.providerReported = out.providerReported || record.providerReported === true;
    const recordAt = count(record.at || record.lastAt);
    if (recordAt && (!out.lastAt || recordAt >= out.lastAt)) {
      out.lastAt = recordAt;
      out.lastProvider = String(record.provider || record.lastProvider || "");
      out.lastModel = String(record.model || record.lastModel || "");
      out.lastPhase = String(record.phase || record.lastPhase || "");
    }
  }
  return out;
}

export function cacheHitRate(usage) {
  const input = count(usage && usage.inputTokens);
  return input ? count(usage && usage.cacheReadTokens) / input : 0;
}
