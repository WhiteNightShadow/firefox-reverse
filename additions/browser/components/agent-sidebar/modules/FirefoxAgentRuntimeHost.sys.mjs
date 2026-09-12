/* FirefoxAgentRuntimeHost.sys.mjs — Firefox-only adapter for AgentRuntime.
 *
 * All privileged composition lives here: Timer.sys.mjs, application shutdown,
 * browser tool backends, and the ToolRouter singleton. Platform-neutral runtime
 * code depends on this narrow host object instead of importing Firefox APIs.
 */

import { ToolRouter } from "./ToolRouter.sys.mjs";
import { createBuiltinTools } from "./Tools.sys.mjs";
import { getBackends } from "./Backends.sys.mjs";

const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
let sharedRouter = null;

function router() {
  if (!sharedRouter) {
    sharedRouter = new ToolRouter();
    sharedRouter.registerAll(createBuiltinTools(getBackends()));
  }
  return sharedRouter;
}

function onShutdown(callback) {
  const observer = {
    observe() {
      callback();
    },
  };
  Services.obs.addObserver(observer, "quit-application-granted");
  return () => {
    try {
      Services.obs.removeObserver(observer, "quit-application-granted");
    } catch {
      // The observer service may already be shutting down.
    }
  };
}

export const firefoxAgentRuntimeHost = Object.freeze({
  timers: Object.freeze({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  }),
  router,
  backends: getBackends,
  onShutdown,
  llmTransport: Object.freeze({
    fetch: (...args) => globalThis.fetch(...args),
    createAbortController: () => new AbortController(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  }),
});
