import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantBody, StepList } from "../content/AgentPanel.jsx";

const result = `## 结论

**接口验证完成**。使用 \`navigator.language\` 获取的语言为简体中文，返回结果符合预期。

### 验证结果

| 检查项 | 状态 | 返回值 |
| :--- | :---: | ---: |
| HTTP 请求 | 通过 | 200 |
| 响应结构 | 通过 | 12 条记录 |
| 语言 | 通过 | zh-CN |

### 下一步

1. 保留本次验证的输入样本。
2. 执行本地回归：
   - [x] 请求格式
   - [x] 响应结构
   - [ ] 异常处理

> 当前结论来自已验证样本，缺少的异常场景仍需补测。

\`\`\`javascript
const result = await readFixture("sample.json");
if (result.status === 200) {
  console.log(result.data);
}
\`\`\`

参考 [Mozilla 文档](https://developer.mozilla.org/)。
`;

const hostile = '<script>window.markdownExecuted = true</script>\n\n<img src="https://example.com/pixel.png" onerror="alert(1)">\n\n[执行](javascript:alert%281%29)\n\n[系统页面](chrome://browser/content/browser.xhtml)\n\n[本地文件](file:///etc/passwd)\n\n![外部截图](https://example.com/pixel.png)';
const long = "## 长内容\n\nhttps://example.com/" + "long-path-".repeat(50) + "\n\n```json\n" + JSON.stringify({ query: "A".repeat(400), status: 200 }) + "\n```\n\n" +
  "|" + Array.from({ length: 10 }, (_, i) => "字段 " + i).join("|") + "|\n|" + "---|".repeat(10) + "\n|" + "数据|".repeat(10);

function Preview() {
  const [mode, setMode] = useState("complete");
  const [liveText, setLiveText] = useState("## 正在验证\n\n```js\nconst result = ");
  globalThis.markdownPreview = { setMode, setLiveText };
  const steps = [
    { kind: "think", text: "**先检查返回值**，再核对响应结构。" },
    { kind: "tool", name: "page_info", status: "ok", summary: "页面信息已获取" },
    { kind: "text", text: result },
  ];
  return (
    <div className="agent-panel">
      <header className="agent-panel__bar"><span>Firefox-Reverse-Agent</span><span>AI辅助</span></header>
      <div className="agent-panel__messages">
        <div className="msg msg--user">
          <div className="msg__role">你</div>
          <div className="msg__content">验证接口并列出结果，给出代码和下一步。</div>
        </div>
        <div className="msg msg--assistant">
          <div className="msg__role">Agent助手</div>
          {mode === "live" ? <div className="msg__content msg__content--live"><StepList steps={[{ kind: "text", text: liveText }]} live /></div>
            : mode === "complete" ? <AssistantBody steps={steps} content={result} />
              : <AssistantBody content={mode === "long" ? long : mode === "unsafe" ? hostile : result} />}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
