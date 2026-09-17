import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const upstream = process.argv[2] || process.env.FRX_UPSTREAM_DIR;
assert(upstream, "Pass a patched Gecko source directory");
const source = await fs.readFile(path.join(upstream, "toolkit/components/extensions/ExtensionParent.sys.mjs"), "utf8");
const start = source.indexOf("class HiddenXULWindow {");
const end = source.indexOf("\nconst SharedWindow =", start);
assert(start >= 0 && end > start);
const implementation = source.slice(start, end) + "\nglobalThis.HiddenXULWindow = HiddenXULWindow;";

function fixture({ load = true, frame = true, alreadyQuit = false } = {}) {
  const controller = new AbortController();
  let abortListeners = 0;
  for (const [method, delta] of [["addEventListener", 1], ["removeEventListener", -1]]) {
    const original = controller.signal[method].bind(controller.signal);
    controller.signal[method] = (...args) => { abortListeners += delta; return original(...args); };
  }
  const browsers = [];
  const progress = {
    listener: null,
    registered: false,
    addProgressListener(listener) { assert.equal(this.listener, null); this.listener = listener; this.registered = true; },
    removeProgressListener(listener) { assert.equal(this.listener, listener); this.listener = null; },
    stop() { this.listener?.onStateChange(null, null, 16); },
  };
  let closes = 0;
  const browserDocument = {
    createXULElement() {
      const browser = new EventTarget();
      const attributes = new Map();
      Object.assign(browser, {
        removed: false,
        setAttribute: (key, value) => attributes.set(key, value),
        hasAttribute: key => attributes.has(key),
        getBoundingClientRect: () => ({}),
        remove() { this.removed = true; },
      });
      browsers.push(browser);
      return browser;
    },
    documentElement: {
      appendChild(browser) { if (frame) queueMicrotask(() => browser.dispatchEvent(new Event("XULFrameLoaderCreated"))); },
    },
  };
  const webNav = {
    loadURI() {
      assert(progress.registered, "listener must be installed before navigation");
      if (load) queueMicrotask(() => progress.stop());
    },
  };
  const windowless = {
    docShell: { QueryInterface: () => webNav }, browsingContext: {}, document: browserDocument,
    QueryInterface() { return { getInterface: () => progress }; },
    close() { closes++; },
  };
  const services = {
    appShell: { createWindowlessBrowser: () => windowless },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    startup: { shuttingDown: alreadyQuit },
  };
  if (alreadyQuit) controller.abort();
  const context = vm.createContext({
    Services: services, DUMMY_PAGE_URI: {}, ExtensionParent: { shutdownSignal: controller.signal },
    lazy: { PrivateBrowsingUtils: { permanentPrivateBrowsing: false } },
    Ci: { nsIWebNavigation: {}, nsIInterfaceRequestor: {}, nsIWebProgress: { NOTIFY_STATE_DOCUMENT: 32 }, nsIWebProgressListener: { STATE_STOP: 16 } },
    ChromeUtils: { generateQI: () => function () { return this; } }, Cu: { reportError() {} },
  });
  vm.runInContext(implementation, context);
  const window = new context.HiddenXULWindow();
  return {
    window, browsers, progress,
    quit() { services.startup.shuttingDown = true; controller.abort(); },
    clean() { assert.equal(progress.listener, null); assert.equal(abortListeners, 0); },
    closed() { assert.equal(closes, 1); },
  };
}

for (const remote of [true, false]) {
  const f = fixture();
  const browser = await f.window.createBrowserElement(remote ? { remote: "true" } : { id: "local" });
  assert.equal(browser.docShellIsActive, true);
  assert.equal(browser.removed, false);
  f.clean(); f.window.shutdown(); f.closed();
}
for (const alreadyQuit of [false, true]) {
  const f = fixture({ load: false, alreadyQuit });
  if (!alreadyQuit) f.quit();
  await assert.rejects(f.window.createBrowserElement({ remote: "true" }), /Cannot create hidden browser past shutdown/);
  f.clean(); f.window.shutdown(); f.closed();
}
{
  const f = fixture({ frame: false });
  await f.window.waitInitialized;
  const pending = f.window.createBrowserElement({ remote: "true" });
  await Promise.resolve();
  assert.equal(f.browsers.length, 1);
  f.quit();
  await assert.rejects(pending, /Aborted hidden browser creation at shutdown/);
  assert.equal(f.browsers[0].removed, true);
  f.clean(); f.window.shutdown(); f.closed();
}
{
  const f = fixture({ load: false });
  let initialized = false;
  f.window.waitInitialized.then(() => { initialized = true; });
  f.progress.listener.onStateChange(null, null, 1);
  await Promise.resolve();
  assert.equal(initialized, false);
  f.progress.stop(); await f.window.waitInitialized;
  assert.equal(initialized, true);
  f.clean(); f.window.shutdown(); f.closed();
}
console.log("HiddenXULWindow: normal remote/local creation, early/already quit, frame-loader abort and listener cleanup passed");
