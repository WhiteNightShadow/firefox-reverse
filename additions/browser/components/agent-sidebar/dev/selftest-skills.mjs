/* dev/selftest-skills.mjs — Skill frontmatter、发现、读取与路径边界自测。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSkillFrontmatter, SkillRegistry } from "../modules/SkillBackend.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  OK", m)) : (fail++, console.error("  FAIL", m)));

const parsed = parseSkillFrontmatter(`---
name: api-audit
description: >
  API 审计与
  回归验证
---
# Instructions
按步骤执行。
`);
ok(parsed.name === "api-audit", "解析 Skill 名称");
ok(parsed.description === "API 审计与 回归验证", "解析折叠描述");
ok(parsed.body.includes("# Instructions"), "保留正文");

const plain = parseSkillFrontmatter("# No frontmatter");
ok(plain.name === "" && plain.body.startsWith("# No"), "无 frontmatter 时安全降级");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "frx-skills-"));
const home = path.join(tmp, "home");
const workspace = path.join(tmp, "workspace");
const skillDir = path.join(workspace, ".agents", "skills", "api-audit");
await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: api-audit\ndescription: API 安全审计\n---\n# Audit\n`, "utf8");
await fs.writeFile(path.join(skillDir, "references", "rules.md"), "只读取已授权目标。", "utf8");

globalThis.PathUtils = {
  homeDir: home,
  join: (...parts) => path.join(...parts),
  filename: p => path.basename(p),
};
globalThis.Services = { env: { get: () => "" } };
globalThis.IOUtils = {
  async getChildren(p) { return (await fs.readdir(p)).map(name => path.join(p, name)); },
  async stat(p) {
    const s = await fs.stat(p);
    return { type: s.isDirectory() ? "directory" : "regular", size: s.size };
  },
  readUTF8: p => fs.readFile(p, "utf8"),
  realPath: p => fs.realpath(p),
};

const registry = new SkillRegistry({ workspace: { getRoot: () => workspace } });
const listed = await registry.list({}, { workspaceRoot: workspace });
ok(listed.ok && listed.skills.some(s => s.name === "reverse-engineering"), "始终列出内置 Skill 元数据");
ok(listed.skills.some(s => s.name === "api-audit" && s.source === "workspace"), "发现工作区 Skill");
const loaded = await registry.get({ name: "api-audit" }, { workspaceRoot: workspace });
ok(loaded.ok && loaded.skill.includes("# Audit"), "按名称读取完整 SKILL.md");
ok(loaded.resources.includes("references/rules.md"), "列出 Skill 附加资源");
const chunked = await registry.get({ name: "api-audit", offset: 0, limit: 8 }, { workspaceRoot: workspace });
ok(chunked.ok && chunked.skill.length === 8 && chunked.nextOffset === 8, "大 Skill 支持按 nextOffset 分段读取");
const resource = await registry.readResource({ name: "api-audit", path: "references/rules.md" }, { workspaceRoot: workspace });
ok(resource.ok && resource.content.includes("已授权"), "读取 Skill 文本资源");
const escaped = await registry.readResource({ name: "api-audit", path: "../secret.txt" }, { workspaceRoot: workspace });
ok(!escaped.ok, "拒绝越过 Skill 根目录的路径");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nSkillRegistry 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
