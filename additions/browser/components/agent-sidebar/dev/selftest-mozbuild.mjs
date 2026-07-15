/* Verify the strict case-insensitive ordering required by Mozilla moz.build. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mozBuildPath = fileURLToPath(new URL("../moz.build", import.meta.url));
const source = fs.readFileSync(mozBuildPath, "utf8");
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

console.log(`moz.build module order: OK (${entries.length} files)`);
