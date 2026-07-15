/* ReasoningEffort.sys.mjs - shared validation for OpenAI-compatible reasoning_effort. */

export const REASONING_EFFORT_AUTO = "auto";

// This is the union exposed by current OpenAI-compatible reasoning models.
// Individual models may support only a subset, so "auto" deliberately omits
// the request field and lets the selected model or gateway choose its default.
export const REASONING_EFFORT_VALUES = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const VALID_REASONING_EFFORTS = new Set([
  REASONING_EFFORT_AUTO,
  ...REASONING_EFFORT_VALUES,
]);

/** Normalize a persisted or caller-provided reasoning effort to a safe value. */
export function normalizeReasoningEffort(value, fallback = REASONING_EFFORT_AUTO) {
  const normalizedFallback = String(fallback || "")
    .trim()
    .toLowerCase();
  const safeFallback = VALID_REASONING_EFFORTS.has(normalizedFallback)
    ? normalizedFallback
    : REASONING_EFFORT_AUTO;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_REASONING_EFFORTS.has(normalized) ? normalized : safeFallback;
}
