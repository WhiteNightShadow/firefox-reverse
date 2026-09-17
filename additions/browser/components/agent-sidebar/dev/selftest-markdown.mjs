import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.markdown-test-"));
try {
  await build({
    absWorkingDir: sidebar,
    entryPoints: ["content/MarkdownContent.jsx", "content/AgentPanel.jsx"],
    outdir: temp, bundle: true, platform: "node", format: "esm",
    external: ["react"], outExtension: { ".js": ".mjs" },
  });
  const { default: Markdown, markdownWebUrl } = await import(pathToFileURL(join(temp, "MarkdownContent.mjs")));
  const { AssistantBody, StepList } = await import(pathToFileURL(join(temp, "AgentPanel.mjs")));
  const render = text => renderToStaticMarkup(React.createElement(Markdown, null, text));
  const prose = render("## 结论\n\n**已完成** *验证* ~~旧假设~~ `navigator.language`\n\n> 引用\n\n1. 第一项\n2. 第二项\n\n- 一级\n  - 二级\n\n- [x] 完成\n- [ ] 待验证");
  for (const fragment of ["<h2>结论</h2>", "<strong>已完成</strong>", "<em>验证</em>", "<del>旧假设</del>", "<code>navigator.language</code>", "<blockquote>", "<ol>", "<ul>", 'type="checkbox" disabled=""']) {
    assert(prose.includes(fragment), fragment);
  }
  const table = render("| 参数 | 结果 |\n| --- | ---: |\n| language | zh-CN |\n| status | 200 |");
  assert(table.includes('class="markdown-body__table"'));
  assert(table.includes("<table>") && table.includes("<th>参数</th>") && table.includes("zh-CN"));
  assert(table.includes('style="text-align:right"'));
  console.log("PASS headings, formatting, quotes, nested lists, task lists and GFM tables");

  const code = render('```js\nconst html = "<script>alert(1)</script>";\n  return html;\n```');
  assert(code.includes('<pre tabindex="0"><code class="language-js">'));
  assert(code.includes("  return html;\n"));
  assert(code.includes("&lt;script&gt;") && !code.includes("<script>"));
  for (const partial of ["```", "```js\nconst a = ", "| 参数 |", "**还在", "[链接](https://", "- [", "<scr"]) {
    assert.doesNotThrow(() => render(partial));
  }
  assert(render("```js\nconst a = 1").includes("const a = 1"));
  console.log("PASS code whitespace and incomplete streaming Markdown remain readable");

  const unsafe = render('<script>globalThis.compromised=1</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="x" onerror="alert(1)">\n\n[execute](javascript:alert%281%29)\n\n[internal](chrome://browser/content/browser.xhtml)\n\n[file](file:///etc/passwd)\n\n![image](https://example.com/pixel.png)');
  assert(!/<(script|iframe|img)\b/i.test(unsafe));
  assert(!/href="(?:javascript|chrome|file):/i.test(unsafe));
  assert(unsafe.includes("execute") && unsafe.includes("internal") && unsafe.includes("file"));
  assert(unsafe.includes('href="https://example.com/pixel.png"'));
  const safe = render("[报告](https://example.com/report?q=1)\n\nhttps://example.com");
  assert(safe.includes('target="_blank" rel="noopener noreferrer"'));
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "chrome://browser/", "resource://gre/", "file:///tmp/a", "//example.com", "../a", "https://user:pass@example.com", "javascript&#58;alert(1)"]) {
    assert.equal(markdownWebUrl(url), "", url);
  }
  assert.equal(markdownWebUrl("https://example.com/a"), "https://example.com/a");
  console.log("PASS raw HTML stays text, privileged URLs are blocked, images do not auto-load");

  const stored = renderToStaticMarkup(React.createElement(AssistantBody, { content: "## 历史结论\n\n**保留**", steps: [] }));
  assert(stored.includes("<h2>历史结论</h2>") && stored.includes("<strong>保留</strong>"));
  const steps = [
    { kind: "think", text: "**思考内容**" },
    { kind: "tool", name: "page_info", status: "ok", summary: "<script>raw tool</script>" },
    { kind: "text", text: "## 结论\n\n| key | value |\n|---|---|\n| status | ok |" },
  ];
  const complete = renderToStaticMarkup(React.createElement(AssistantBody, { steps, content: "raw fallback" }));
  assert(complete.includes("<strong>思考内容</strong>") && complete.includes("<table>"));
  assert(complete.includes("&lt;script&gt;raw tool&lt;/script&gt;"));
  assert(complete.includes("收起过程，只看结论"));
  const live = renderToStaticMarkup(React.createElement(StepList, { steps, live: true }));
  assert(live.includes("<h2>结论</h2>") && live.includes('class="msg__cursor"'));
  console.log("PASS history, completed steps and live steps render Markdown; tool summaries stay text");
  console.log("Markdown selftest: all passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
