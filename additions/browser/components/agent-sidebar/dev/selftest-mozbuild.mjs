/* Verify the strict case-insensitive ordering required by Mozilla moz.build. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mozBuildPath = fileURLToPath(new URL("../moz.build", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const localePrefsPath = fileURLToPath(new URL("../preferences/frx-locale.js", import.meta.url));
const localeMozBuildPath = fileURLToPath(new URL("../preferences/moz.build", import.meta.url));
const fingerprintPatchPath = fileURLToPath(new URL("../../../../../scripts/apply-fingerprint-config.py", import.meta.url));
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

console.log(`moz.build module order, zh-CN defaults, and chrome UI fingerprint isolation: OK (${entries.length} files)`);
