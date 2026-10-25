/* dev/selftest-markdown-streaming.mjs — 流式输出时按块渲染 Markdown。
 * 任意前缀（模拟流式输出的任意时刻）按块渲染的 HTML 必须和整段渲染逐字节相同；长回复每拍需要重新解析的
 * 字数只剩最后一块。
 *
 *   node dev/selftest-markdown-streaming.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const corpus = [
  // 典型的分析回复：标题、段落、行内格式、列表、表格、代码
  `## 结论

签名参数 \`sign\` 来自 **webpack** 模块 \`a3f9\`，由 [MD5](https://example.com/md5) 加盐生成。

### 关键步骤

1. 取请求参数，按 key 排序
2. 拼接 \`appKey\` 和时间戳
3. 计算 MD5

- 已验证：本地复现与线上一致
- 待确认：
  - 时间戳精度
  - 盐值是否轮换

| 参数 | 来源 | 说明 |
| --- | :---: | ---: |
| sign | 计算 | 32 位 |
| t | Date.now() | 毫秒 |

\`\`\`js
function sign(params) {
  const keys = Object.keys(params).sort();

  return md5(keys.map(k => k + "=" + params[k]).join("&") + SALT);
}
\`\`\`

> 注意：盐值在 \`chunk-vendors.js\` 里
>
> 第二段引用

> 另一个引用块

---

最后一段，带 *强调*、~~删除线~~ 和自动链接 https://example.com/a?b=c 。
`,
  // 松散列表、有序列表起始号、任务列表、列表里的代码与续行
  `- 第一项

- 第二项，松散列表

  续行段落属于第二项

3. 从 3 开始
4. 第四

- [x] 完成
- [ ] 未完成

1. 列表里的代码：

   \`\`\`python
   def f():

       return 1
   \`\`\`

   代码后的续行

普通段落结束列表。
`,
  // 围栏变体：~~~、更长的围栏、信息串里有反引号的假围栏、未闭合的围栏
  `开头段落

~~~
tilde fence

\`\`\`
not a close
~~~

\`\`\`\`markdown
\`\`\`
inner fence text

\`\`\`
\`\`\`\`

\`\`\` js\`bad
这不是围栏，是段落

后面还是普通段落

\`\`\`
真正的围栏

未闭合
`,
  // 缩进代码、HTML 注释与块、setext 标题、分隔线、硬换行、转义
  `段落一

    indented code

    still code

标题
===

副标题
---

***

<!--
注释里的空行

仍在注释里
-->

<pre>
预格式

文本
</pre>

行尾两个空格
硬换行，反斜杠\\
换行，\\*不是强调\\*

* * *

+ 加号列表

段落 <span>行内 HTML</span> 结束
`,
  // 链接引用与脚注：定义在后面
  `参见[文档][doc]和脚注[^1]。

第二段

[doc]: https://example.com/doc "文档"
[^1]: 脚注内容
`,
  // 引用里的列表和代码，紧接段落
  `> - 引用里的列表
>   - 二级
>
> \`\`\`
> 引用里的代码
> \`\`\`

后续段落

> 懒续行
继续同一段

1) 括号编号
2) 第二

最后
`,
  // CRLF 换行
  "第一段\r\n\r\n- 列表\r\n-\r\n\r\n第二段\r\n\r\n```\r\ncode\r\n\r\nmore\r\n```\r\n\r\n收尾\r\n",
  // 只有空行开头、连续空行
  "\n\n\n开头有空行\n\n\n\n中间多空行\n\n   \n\t\n结尾\n\n\n",
  // 列表项里的围栏随列表项结束而关闭，后面的 ``` 其实开启了新围栏
  "1. 步骤：\n\n   ```\n   x\n\n  不够缩进，列表项结束\n  ```\n\n\n仍在新围栏里\n\n```\n\n之后\n",
  // 引用里的围栏随空行结束
  "> ```\n> code\n\n```\n新围栏\n\n仍在围栏里\n```\n\n结束\n",
  // 缩进代码之后、末尾是空列表项的引用（micromark 整段解析时按段落处理）
  "\tcode\n\n> - 引用里的列表\n\n    code\n\n> 1. 有序\n",
  // HTML 块类型 3–5
  "<?xml version=\"1.0\"\n\n?>\n\n<!DOCTYPE html\n\n>\n\n<![CDATA[\n\n]]>\n\n结束\n",
  // 审查时找到的反例
  "```\n> ```\n\na\n",
  "<details>\n```js\n\nb\n```\n\nc\n",
  "<s>\n<!X\n\n<pre>\n\nh\n",
  "参考[1]和[2]。\n\n说明\n\n- [1]: https://a.com\n- [2]: https://b.com\n",
  "[x]\n\n> [x]: /u\n",
  "see [foo bar]\n\n[foo\nbar]: https://x\n",
  "a[^1]\n\n> [^1]: note\n",
  "a\n\u3000\nb\n\n\u00a0\n\nc\n",
  "```\ncode\n```\u3000\n\nb\n",
  "    code\n\n>  2. x\n\n    code\n\n>  -\n",
  "- ```\n  code\n\n\nnext\n",
  "1. item\n\n    ```\n    code\n\n\nnext\n",
  "```\r\rcode\n\nb\n",
  "> > ```\n> > code\n> \n> more\n\nafter\n",
];

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.markdown-streaming-test-"));
try {
  await build({
    absWorkingDir: sidebar,
    entryPoints: ["content/MarkdownContent.jsx"],
    outdir: temp,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react"],
    outExtension: { ".js": ".mjs" },
  });
  const { default: Markdown, streamingBlocks } = await import(pathToFileURL(join(temp, "MarkdownContent.mjs")));
  const render = (text, streaming) => renderToStaticMarkup(React.createElement(Markdown, { streaming }, text));

  // 1. 任意前缀：按块渲染与整段渲染逐字节相同
  let prefixes = 0;
  let splitPrefixes = 0;
  for (const [n, doc] of corpus.entries()) {
    const cuts = new Set([doc.length]);
    for (let i = 0; i < doc.length; i++) {
      if (doc[i] === "\n" || i % 5 === 0) {
        for (const d of [-1, 0, 1, 2]) {
          if (i + d > 0 && i + d <= doc.length) {
            cuts.add(i + d);
          }
        }
      }
    }
    for (const cut of [...cuts].sort((a, b) => a - b)) {
      const prefix = doc.slice(0, cut);
      const full = render(prefix, false);
      const streamed = render(prefix, true);
      if (streamed !== full) {
        // 抛错而不是 process.exit：finally 才会清掉临时目录
        throw new Error(`MISMATCH in corpus #${n} at ${cut}:\n--- prefix ---\n${JSON.stringify(prefix.slice(-200))}\n--- full ---\n${full.slice(-400)}\n--- streamed ---\n${streamed.slice(-400)}`);
      }
      prefixes++;
      if (streamingBlocks(prefix).length > 1) {
        splitPrefixes++;
      }
    }
  }
  assert(splitPrefixes > prefixes / 3, `大部分前缀确实被切成多块（${splitPrefixes}/${prefixes}）`);
  console.log(`PASS ${prefixes} 个前缀按块渲染与整段渲染逐字节相同（其中 ${splitPrefixes} 个切成了多块）`);

  // 2. 切分规则
  const starts = text => streamingBlocks(text).map(b => b.start);
  const at = (text, marker) => text.indexOf(marker);
  for (const [text, expected, why] of [
    ["a\n\nb\n\nc", ["b", "c"], "顶格的新段落处切开"],
    ["a\n\nb", ["b"], "下一段刚写出第一个字就能切，上一段不再反复解析"],
    ["a\n\n", [], "下一段还没开始时不切"],
    ["a\n\n1", ["1"], "单独的数字在这一拍里只是段落"],
    ["a\n\n1. ", [], "写成列表项后不再切（每拍按当前文本重新判断）"],
    ["- a\n\n- b\n\nc\n", ["c"], "列表项之间不切（可能是同一个松散列表）"],
    ["- a\n\n  续行\n\nc\n", ["c"], "缩进续行不切"],
    ["```\na\n\nb\n```\n\nc\n", ["c"], "代码围栏里的空行不切"],
    ["```\na\n\nb\n", [], "未闭合的围栏之后都不切"],
    ["a\n\n<!--\n\nx\n\n-->\n\nc\n", ["<!--"], "HTML 开头的行之前可以切，之后不再往后切"],
    ["```\nx\n\n```\n\n> ```\n> y\n\nz\n", ["> ```"], "引用里的围栏随空行结束后不再往后切"],
    ["- ```\n  code\n\n\nnext\n", [], "列表项里的围栏遇到顶格行（外层结束）后不再往后切"],
    ["a\n\u3000\nb\n", [], "全角空格不是空行"],
    ["a\n\n- [1]: https://x\n", [], "列表项里的链接定义：整段不切"],
    ["a\n\n```ts\n[key: string]: any\n```\n\nb\n", ["```ts", "b"], "代码块里像定义的行不影响切分"],
    ["[a]\n\nb\n\n[a]: https://x\n", [], "有链接引用定义时整段不切"],
    ["\n\na\n\nb\n", ["b"], "开头的空行不单独成块"],
  ]) {
    assert.deepEqual(starts(text), [0, ...expected.map(marker => at(text, marker))], why);
  }
  assert.equal(streamingBlocks("a\n\nb\n\nc").map(b => b.text).join(""), "a\n\nb\n\nc", "各块首尾相接还原原文");
  // 深层引用前缀不能让切块的正则回溯爆炸（侧栏跑在父进程主线程上，每拍都会执行）
  const deep = "前言\n\n" + "> ".repeat(32) + "x".repeat(20) + "\n\n" + ("> ".repeat(31) + "```\n").repeat(3);
  const t0 = performance.now();
  render(deep, true);
  streamingBlocks(deep + "y");
  assert(performance.now() - t0 < 500, `深层引用前缀的处理时间 ${(performance.now() - t0).toFixed(0)}ms`);
  console.log("PASS 只在安全的空行处切：围栏、HTML 块、列表、续行、链接定义都不会被切开");

  // 3. 长回复：每拍需要重新解析的字数（已缓存的块不再解析）
  const paragraph = i => `第 ${i} 段：分析请求参数与签名流程，记录 \`param_${i}\` 的来源和变换步骤，并给出复现结论。\n\n`;
  const long = Array.from({ length: 120 }, (_, i) => (i % 10 === 5 ? "```js\nconst x = " + i + ";\n\nreturn x;\n```\n\n" : paragraph(i))).join("");
  let before = [];
  let fullWork = 0;
  let streamWork = 0;
  for (let cut = 40; cut <= long.length; cut += 40) {
    const prefix = long.slice(0, cut);
    const blocks = streamingBlocks(prefix);
    const cached = new Set(before.slice(0, -1).map(b => b.start + ":" + b.text));
    fullWork += prefix.length;
    streamWork += blocks.filter((b, i) => i === blocks.length - 1 || !cached.has(b.start + ":" + b.text)).reduce((sum, b) => sum + b.text.length, 0);
    before = blocks;
  }
  const ratio = streamWork / fullWork;
  assert(ratio < 0.05, `长回复每拍只重新解析最后一块（解析量为整段渲染的 ${(ratio * 100).toFixed(1)}%）`);
  console.log(`PASS ${long.length} 字的回复按 40 字一拍流式输出：解析量为整段渲染的 ${(ratio * 100).toFixed(1)}%`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
