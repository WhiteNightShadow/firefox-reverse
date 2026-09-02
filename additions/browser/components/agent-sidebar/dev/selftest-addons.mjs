import { AddonBackend } from "../modules/AddonBackend.sys.mjs";
import { createBuiltinTools } from "../modules/Tools.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";

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

const installed = new Map();
function fakeAddon(overrides = {}) {
  const addon = {
    id: "user@example.test",
    name: "User Extension",
    version: "1.0",
    type: "extension",
    isActive: true,
    userDisabled: false,
    appDisabled: false,
    signedState: 2,
    permissions: 1 | 2 | 4,
    optionsURL: "moz-extension://unit-test/options.html",
    scope: 1,
    async enable() { this.userDisabled = false; this.isActive = true; },
    async disable() { this.userDisabled = true; this.isActive = false; },
    async uninstall() { this.uninstalled = true; installed.delete(this.id); },
    ...overrides,
  };
  return addon;
}

const userAddon = fakeAddon();
const systemAddon = fakeAddon({
  id: "system@example.test",
  name: "System Extension",
  isSystem: true,
  scope: 4,
});
installed.set(userAddon.id, userAddon);
installed.set(systemAddon.id, systemAddon);

let installRequest = null;
const manager = {
  readyPromise: Promise.resolve(),
  PERM_CAN_UNINSTALL: 1,
  PERM_CAN_ENABLE: 2,
  PERM_CAN_DISABLE: 4,
  SCOPE_PROFILE: 1,
  SCOPE_APPLICATION: 4,
  SCOPE_SYSTEM: 8,
  SIGNEDSTATE_SIGNED: 2,
  async getAllAddons() { return [...installed.values()]; },
  async getAddonByID(id) { return installed.get(id) || null; },
  async getInstallForURL(url, opts) {
    installRequest = { url, opts };
    const unsigned = url.includes("unsigned");
    return {
      error: 0,
      async install() {
        const id = unsigned ? "unsigned@example.test" : "amo@example.test";
        const addon = fakeAddon({
          id,
          name: unsigned ? "Unsigned" : "AMO Extension",
          version: "2.0",
          signedState: unsigned ? 0 : 2,
        });
        installed.set(id, addon);
        return addon;
      },
    };
  },
  errorToString(code) { return `ERR_${code}`; },
};

function amoItem({ slug = "amo-extension", guid = "amo@example.test", xpiHost = "addons.mozilla.org" } = {}) {
  return {
    id: 42,
    slug,
    guid,
    type: "extension",
    status: "public",
    is_disabled: false,
    name: { "en-US": "AMO Extension" },
    summary: { "en-US": "Useful extension" },
    authors: [{ name: "Author" }],
    average_daily_users: 100,
    weekly_downloads: 20,
    ratings: { average: 4.5 },
    url: `https://addons.mozilla.org/firefox/addon/${slug}/`,
    current_version: {
      version: "2.0",
      compatibility: { firefox: { min: "120.0", max: "*" } },
      file: {
        status: "public",
        hash: "sha256:" + "a".repeat(64),
        url: `https://${xpiHost}/firefox/downloads/file/123/${slug}-2.0.xpi`,
        permissions: ["tabs", "storage"],
        optional_permissions: ["downloads"],
      },
    },
  };
}

const fetched = [];
const fetchImpl = async url => {
  fetched.push(String(url));
  const href = String(url);
  let data;
  if (href.includes("/search/")) {
    data = { count: 1, results: [amoItem()] };
  } else if (href.includes("/addon/unsigned/")) {
    data = amoItem({ slug: "unsigned", guid: "unsigned@example.test" });
  } else if (href.includes("/addon/evil/")) {
    data = amoItem({ slug: "evil", guid: "evil@example.test", xpiHost: "evil.example" });
  } else {
    data = amoItem();
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

let opened = null;
const backend = new AddonBackend({
  addonManager: manager,
  fetchImpl,
  appVersion: "153.0a1",
  locale: "zh-CN",
  openURL: async url => { opened = url; },
});

console.log("[1] AMO search + installed list");
const search = await backend.query({ action: "search", query: "hook", limit: 5 });
ok(search.ok && search.results[0].installRef === "amo-extension", "AMO search returns bounded installRef");
ok(search.results[0].permissionCount === 3 && search.results[0].untrustedMetadata, "search exposes permissions and marks metadata untrusted");
ok(fetched[0].includes("appversion=153.0a1") && fetched[0].includes("page_size=5"), "search filters by current Firefox version and limit");

const list = await backend.query({ action: "list" });
ok(list.count === 1 && list.addons[0].id === userAddon.id, "list excludes system extensions by default");
ok((await backend.query({ action: "list", includeSystem: true })).count === 2, "list can include protected extensions for diagnostics");
ok((await backend.query({ action: "get", id: userAddon.id })).addon.hasOptions, "get reports options-page availability");

console.log("[2] enable/disable + options page");
await backend.manage({ action: "disable", id: userAddon.id });
ok(userAddon.userDisabled && !userAddon.isActive, "disable uses AddonManager permission path");
await backend.manage({ action: "enable", id: userAddon.id });
ok(!userAddon.userDisabled && userAddon.isActive, "enable restores extension");
const options = await backend.manage({ action: "open_options", id: userAddon.id });
ok(options.opened && opened === userAddon.optionsURL && /page_type/.test(options.next), "open_options returns page-automation continuation");

console.log("[3] AMO-only install + signature rollback");
let missingConfirm = false;
try { await backend.manage({ action: "install", ref: "amo-extension" }); } catch { missingConfirm = true; }
ok(missingConfirm, "install requires explicit confirm:true");
const installedResult = await backend.manage({ action: "install", ref: "amo-extension", confirm: true });
ok(installedResult.signatureVerified && installedResult.addon.id === "amo@example.test", "signed AMO extension installs successfully");
ok(installRequest.opts.hash.startsWith("sha256:") && installRequest.url.includes("addons.mozilla.org"), "AMO hash is passed to AddonManager");

let unsignedRejected = false;
try { await backend.manage({ action: "install", ref: "unsigned", confirm: true }); } catch (e) { unsignedRejected = /signed/.test(e.message); }
ok(unsignedRejected && !installed.has("unsigned@example.test"), "unsigned result is rolled back even if the build permits it");
let evilRejected = false;
try { await backend.manage({ action: "install", ref: "evil", confirm: true }); } catch (e) { evilRejected = /unexpected XPI URL/.test(e.message); }
ok(evilRejected, "non-AMO XPI URL is rejected before AddonManager");

console.log("[4] uninstall + protected extension boundary");
let uninstallConfirm = false;
try { await backend.manage({ action: "uninstall", id: userAddon.id }); } catch { uninstallConfirm = true; }
ok(uninstallConfirm, "uninstall requires explicit confirm:true");
let protectedRejected = false;
try { await backend.manage({ action: "disable", id: systemAddon.id }); } catch (e) { protectedRejected = /cannot be modified/.test(e.message); }
ok(protectedRejected, "system extension cannot be modified");
await backend.manage({ action: "uninstall", id: userAddon.id, confirm: true });
ok(!installed.has(userAddon.id), "confirmed uninstall removes user extension");

console.log("[5] ToolRouter registration/confirmation");
const router = new ToolRouter();
router.registerAll(createBuiltinTools({ addons: backend }));
ok(router.has("addons_query") && router.has("addons_manage"), "two additive addon tools register");
ok(!router.needsConfirm("addons_query") && router.needsConfirm("addons_manage"), "read-only query skips confirmation; lifecycle management requires it");

console.log(`\nAddonBackend selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
