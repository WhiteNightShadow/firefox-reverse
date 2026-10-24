/* dev/selftest-tool-metadata.mjs — 工具元数据只有一份来源：Tools.sys.mjs 里每个工具的声明。
 * 验证：确认 / 重复豁免 / 进展三种特性都来自声明；名字像改动型的工具必须需确认；
 * README 工具表与声明一一对应；系统提示词、skill 文档和工具描述里提到的工具名都真实存在。
 *
 *   node dev/selftest-tool-metadata.mjs
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltinTools, declaredToolNames } from "../modules/Tools.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";

let pass = 0,
  fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    fail++;
    console.error("  ✗ FAIL:", msg);
  }
};
const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// 所有 backend 都在场：每个声明的工具都会注册
const anyBackend = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => {} }) });
const router = new ToolRouter().registerAll(createBuiltinTools(anyBackend));
const declared = declaredToolNames();
const declaredSet = new Set(declared);

console.log("[1] 特性来自声明");
ok(declared.length === declaredSet.size && router.names().length === declared.length, `全部 ${declared.length} 个声明都注册了，没有重名`);
ok(router.needsConfirm("run_node") && router.isRepeatExempt("run_node") && !router.countsAsProgress("run_node"), "run_node：需确认、重复豁免、成功不直接算前进（看退出码）");
ok(router.needsConfirm("scripts_save") && router.countsAsProgress("scripts_save") && !router.isRepeatExempt("scripts_save"), "scripts_save：需确认、落盘即前进");
ok(!router.needsConfirm("fs_read") && !router.isRepeatExempt("fs_read") && !router.countsAsProgress("fs_read"), "fs_read：纯查询，三种特性都没有");
ok(router.needsConfirm("js_trace") && router.needsConfirm("wasm_probe"), "js_trace / wasm_probe 会在宿主 Node 里执行页面代码，和 run_node 一样需确认");

console.log("[2] 名字像改动型的工具必须需确认");
const MUTATING = /(^|_)(write|copy|mkdir|delete|remove|create|update|install|run|save|inject|open|close|import|reset|manage|navigate|click|type|eval|capture|generate|trace|add|set|forget)(_|$)/;
// 名字像改动、但只动自己的地盘：工作目录里建目录、会话笔记、给环境自己的 captures 目录记一份快照
const BENIGN = new Set(["fs_mkdir", "notes_add", "env_capture_fingerprint"]);
const unconfirmed = declared.filter(n => MUTATING.test(n) && !BENIGN.has(n) && !router.needsConfirm(n));
ok(unconfirmed.length === 0, `改动型工具都需确认${unconfirmed.length ? "，缺：" + unconfirmed.join(", ") : ""}`);
const staleBenign = [...BENIGN].filter(n => !declaredSet.has(n) || router.needsConfirm(n));
ok(staleBenign.length === 0, `例外名单里没有过期条目${staleBenign.length ? "：" + staleBenign.join(", ") : ""}`);

console.log("[3] README 工具表与声明一一对应");
const readme = read("../../../../../README.md");
const start = readme.indexOf("## 🧰 工具大全");
const section = readme.slice(start, readme.indexOf("\n## ", start + 4));
const rows = section.split("\n").filter(line => line.startsWith("| **"));
const listed = [];
for (const row of rows) {
  const [, category, toolsCell] = row.split("|");
  const claimed = Number((category.match(/（(\d+)）/) || [])[1]);
  const names = [...toolsCell.matchAll(/`([a-z0-9_]+)`/g)].map(m => m[1]);
  listed.push(...names);
  ok(claimed === names.length, `${category.replace(/\*/g, "").trim()}：标的数量与列出的工具数一致`);
}
const listedSet = new Set(listed);
ok(listed.length === listedSet.size, "表里没有重复的工具");
ok(declared.every(n => listedSet.has(n)), `每个声明的工具都在表里${declared.some(n => !listedSet.has(n)) ? "，缺：" + declared.filter(n => !listedSet.has(n)).join(", ") : ""}`);
ok(listed.every(n => declaredSet.has(n)), `表里每个工具都真实存在${listed.some(n => !declaredSet.has(n)) ? "，多：" + listed.filter(n => !declaredSet.has(n)).join(", ") : ""}`);
// README 里提到的总数都要等于声明数；"原 N 个工具名称……" 是历史兼容说明，不算
const counts = [...readme.matchAll(/(\d+) 个工具(?!名称)|工具大全（(\d+)）/g)].map(m => Number(m[1] || m[2]));
ok(counts.length > 0 && counts.every(n => n === declared.length), `README 提到的工具总数都是 ${declared.length}（${counts.join("、")}）`);

console.log("[4] 提示词、skill 和工具描述里提到的工具名都存在");
// 只看给模型读的文字：系统提示词模板、skill 文档、每个工具的描述
function templateLiteral(source, name) {
  const begin = source.indexOf(`const ${name} = \``);
  if (begin < 0) {
    return "";
  }
  let i = begin + `const ${name} = \``.length;
  let text = "";
  for (; i < source.length && source[i] !== "`"; i++) {
    if (source[i] === "\\") {
      text += source[++i];
    } else {
      text += source[i];
    }
  }
  return text;
}
const panel = read("../content/AgentPanel.jsx");
const sources = {
  "系统提示词": ["SYSTEM", "AUTO_BLOCK", "ASSIST_BLOCK"].map(n => templateLiteral(panel, n)).join("\n"),
  "skill-reverse.md": read("../content/skill-reverse.md"),
  "工具描述": router.listSpecs().map(s => s.function.description).join("\n"),
};
ok(sources["系统提示词"].length > 1000, "读到了系统提示词模板");
const prefixes = new Set(declared.map(n => n.split("_")[0]));
// 与工具同前缀、但不是工具的标识符
const NOT_TOOLS = new Set(["wasm_bindgen"]);
for (const [label, text] of Object.entries(sources)) {
  const mentioned = new Set(
    [...text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map(m => m[1]).filter(t => prefixes.has(t.split("_")[0]) && !NOT_TOOLS.has(t))
  );
  const unknown = [...mentioned].filter(t => !declaredSet.has(t));
  ok(unknown.length === 0, `${label}：提到的 ${mentioned.size} 个工具名都存在${unknown.length ? "，不存在：" + unknown.join(", ") : ""}`);
}

console.log(`\n工具元数据自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
