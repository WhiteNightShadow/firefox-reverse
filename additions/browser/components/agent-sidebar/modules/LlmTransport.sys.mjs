/* LlmTransport.sys.mjs — host-neutral transport primitives for LlmClient. */

function required(name) {
  return () => {
    throw new Error(`LlmTransport: ${name} is not available; inject it from the host`);
  };
}

export function createLlmTransport(overrides = {}) {
  const host = overrides || {};
  const fetchImpl =
    typeof host.fetch === "function"
      ? host.fetch
      : typeof globalThis.fetch === "function"
        ? (...args) => globalThis.fetch(...args)
        : required("fetch");
  const createAbortController =
    typeof host.createAbortController === "function"
      ? host.createAbortController
      : typeof globalThis.AbortController === "function"
        ? () => new globalThis.AbortController()
        : required("AbortController");
  const setTimer =
    typeof host.setTimeout === "function"
      ? host.setTimeout
      : typeof globalThis.setTimeout === "function"
        ? globalThis.setTimeout.bind(globalThis)
        : required("setTimeout");
  const clearTimer =
    typeof host.clearTimeout === "function"
      ? host.clearTimeout
      : typeof globalThis.clearTimeout === "function"
        ? globalThis.clearTimeout.bind(globalThis)
        : required("clearTimeout");

  return Object.freeze({
    fetch: fetchImpl,
    createAbortController,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    delay: ms => new Promise(resolve => setTimer(resolve, ms)),
  });
}
