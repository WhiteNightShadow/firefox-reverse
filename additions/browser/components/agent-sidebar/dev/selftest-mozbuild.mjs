/* Verify the strict case-insensitive ordering required by Mozilla moz.build. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mozBuildPath = fileURLToPath(new URL("../moz.build", import.meta.url));
const modulesPath = fileURLToPath(new URL("../modules/", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const localePrefsPath = fileURLToPath(new URL("../preferences/frx-locale.js", import.meta.url));
const localeMozBuildPath = fileURLToPath(new URL("../preferences/moz.build", import.meta.url));
const fingerprintPatchPath = fileURLToPath(new URL("../../../../../scripts/apply-fingerprint-config.py", import.meta.url));
const agentUiPatchPath = fileURLToPath(new URL("../../../../../patches/agent-ui/0001-register-agent-sidebar.patch", import.meta.url));
const releaseWorkflowPath = fileURLToPath(new URL("../../../../../.github/workflows/release.yml", import.meta.url));
const bootstrapPath = fileURLToPath(new URL("../../../../../scripts/bootstrap.sh", import.meta.url));
const buildRelinkPath = fileURLToPath(new URL("../../../../../scripts/force-build-id-relink.sh", import.meta.url));
const source = fs.readFileSync(mozBuildPath, "utf8");
const localeMozBuild = fs.readFileSync(localeMozBuildPath, "utf8");
const packageVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
const block = source.match(/EXTRA_JS_MODULES\.agentsidebar\s*\+=\s*\[([\s\S]*?)\n\]/);

if (!block) {
  console.error("FAIL: EXTRA_JS_MODULES.agentsidebar block not found");
  process.exit(1);
}

const entries = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const sorted = [...entries].sort((left, right) => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
});

if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
  console.error("FAIL: moz.build module list is not sorted");
  console.error("expected:", sorted.join("\n"));
  process.exit(1);
}

const sourceModules = fs
  .readdirSync(modulesPath)
  .filter(name => name.endsWith(".sys.mjs"))
  .map(name => `modules/${name}`)
  .sort();
const registeredModules = [...entries].sort();
if (JSON.stringify(sourceModules) !== JSON.stringify(registeredModules)) {
  const missing = sourceModules.filter(name => !registeredModules.includes(name));
  const stale = registeredModules.filter(name => !sourceModules.includes(name));
  console.error("FAIL: moz.build does not exactly match modules/*.sys.mjs");
  if (missing.length) console.error("unregistered:", missing.join(", "));
  if (stale.length) console.error("missing source:", stale.join(", "));
  process.exit(1);
}

if (!source.includes('DIRS += ["preferences"]')) {
  console.error("FAIL: preferences subdirectory is not registered in moz.build");
  process.exit(1);
}

if (!localeMozBuild.includes('FINAL_TARGET = "dist/bin"')) {
  console.error("FAIL: locale preference target is not the application root");
  process.exit(1);
}

if (!localeMozBuild.includes('DIST_SUBDIR = ""')) {
  console.error("FAIL: locale preference inherits the browser dist subdirectory");
  process.exit(1);
}

if (!localeMozBuild.includes("FINAL_TARGET_FILES.defaults.pref")) {
  console.error("FAIL: zh-CN preference file is not packaged in defaults/pref");
  process.exit(1);
}

const localePrefs = fs.readFileSync(localePrefsPath, "utf8");
for (const expected of [
  `pref("extensions.firefox-reverse.version", "${packageVersion}")`,
  'pref("intl.locale.requested", "zh-CN")',
  'pref("intl.accept_languages", "zh-CN, zh, en-US, en")',
]) {
  if (!localePrefs.includes(expected)) {
    console.error(`FAIL: missing locale default: ${expected}`);
    process.exit(1);
  }
}

const fingerprintPatch = fs.readFileSync(fingerprintPatchPath, "utf8");
for (const expected of [
  "aCallerType == CallerType::NonSystem",
  "ShouldApplyFrxScreenFingerprint(GetOwnerWindow())",
  "!doc->NodePrincipal()->IsSystemPrincipal()",
]) {
  if (!fingerprintPatch.includes(expected)) {
    console.error(`FAIL: fingerprint override leaks into browser chrome: ${expected}`);
    process.exit(1);
  }
}

const agentUiPatch = fs.readFileSync(agentUiPatchPath, "utf8");
for (const expected of [
  'diff --git a/browser/components/moz.build b/browser/components/moz.build',
  '+    "agent-sidebar",',
  '+        "viewAgentSidebar",',
  '+          url: "chrome://browser/content/agent-sidebar/panel.html",',
  '+sidebar-menu-agent-label =',
]) {
  if (!agentUiPatch.includes(expected)) {
    console.error(`FAIL: baseline Agent sidebar registration patch is incomplete: ${expected}`);
    process.exit(1);
  }
}

const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
for (const expected of [
  "FIREFOX_REV: cebc55aab4d2661d1f6c2d1526362947ec4016c1",
  'GECKO_REMOTE: "https://github.com/mozilla-firefox/firefox.git"',
  'MOZ_SOURCE_CHANGESET: ${{ github.sha }}',
  'git -C upstream fetch --depth 1 origin "$FIREFOX_REV"',
  "./mach configure",
  'scripts/force-build-id-relink.sh" "$UPSTREAM/${{ matrix.objdir }}"',
  'grep -F "SourceStamp=$MOZ_SOURCE_CHANGESET"',
  "python firefox-reverse/scripts/apply-fingerprint-config.py upstream",
]) {
  if (!releaseWorkflow.includes(expected)) {
    console.error(`FAIL: release workflow is not pinned/reproducible: ${expected}`);
    process.exit(1);
  }
}
if (releaseWorkflow.includes("apply-patches.sh ) || true")) {
  console.error("FAIL: release workflow silently ignores patch failures");
  process.exit(1);
}

const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
for (const expected of [
  "UPSTREAM_REF:-cebc55aab4d2661d1f6c2d1526362947ec4016c1",
  'git -C "$UPSTREAM_DIR" fetch --depth 1 origin "$UPSTREAM_REF"',
  'git -C "$UPSTREAM_DIR" checkout --detach FETCH_HEAD',
]) {
  if (!bootstrap.includes(expected)) {
    console.error(`FAIL: bootstrap does not pin/fetch the Firefox baseline: ${expected}`);
    process.exit(1);
  }
}

const buildRelink = fs.readFileSync(buildRelinkPath, "utf8");
for (const expected of [
  '"$objdir/buildid.h"',
  '"$objdir/source-repo.h"',
  '"$objdir/.deps/source-repo.h.stub"',
  '"$objdir/.deps/source-repo.h.pp"',
  'grep -aFq "$MOZ_SOURCE_CHANGESET" "$objdir/config.status"',
  "run ./mach configure with the release metadata",
]) {
  if (!buildRelink.includes(expected)) {
    console.error(`FAIL: build metadata relink misses generated input: ${expected}`);
    process.exit(1);
  }
}

console.log(`moz.build order, parent registration, pinned release baseline, locale defaults, and fingerprint isolation: OK (${entries.length} files)`);
