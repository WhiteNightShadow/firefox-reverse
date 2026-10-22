import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

// The sidebar has system privileges. Model-supplied URLs may only open web
// pages; local files, chrome/resource URLs and executable schemes stay text.
export function markdownWebUrl(value) {
  if (!/^https?:\/\//i.test(value || "")) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function openWebLink(event) {
  if (event.button !== 0 && event.button !== 1) return;
  if (typeof ChromeUtils === "undefined") return;
  event.preventDefault();
  const href = markdownWebUrl(event.currentTarget.href);
  if (!href) return;
  const win = event.currentTarget.ownerDocument.defaultView;
  const browser = win.browsingContext?.topChromeWindow ||
    Services.wm.getMostRecentWindow("navigator:browser");
  browser?.openLinkIn(href, "tab", {
    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
    inBackground: event.button === 1 || event.ctrlKey || event.metaKey,
  });
}

function WebLink({ href, title, children }) {
  const url = markdownWebUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a href={url} title={title || url} target="_blank" rel="noopener noreferrer"
      onClick={openWebLink} onAuxClick={openWebLink}>
      {children}
    </a>
  );
}

const components = {
  a: WebLink,
  // Untrusted Markdown must not automatically fetch remote images. Tool
  // screenshots retain their existing, separate image rendering path.
  img: ({ src, alt }) => <WebLink href={src}>{alt || "图片"}</WebLink>,
  table: ({ children }) => (
    <div className="markdown-body__table" role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
};

// 引用/列表嵌套过深会让 Markdown 解析递归溢出；超过阈值直接按纯文本显示，不再尝试解析。
const MAX_NESTING = 32;
const NESTING_PREFIX = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))+/;
const NESTING_MARK = />|[-*+]|\d{1,9}[.)]/g;

export function tooDeeplyNested(text) {
  for (const line of text.split("\n")) {
    const prefix = NESTING_PREFIX.exec(line);
    if (prefix && prefix[0].match(NESTING_MARK).length > MAX_NESTING) {
      return true;
    }
  }
  return false;
}

function PlainText({ text }) {
  return <pre className="markdown-body__plain">{text}</pre>;
}

// 解析或渲染抛错时退回纯文本，避免一条异常回复让整个侧栏白屏；文本变化后重新尝试。
class MarkdownBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, text: props.text };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props, state) {
    return props.text === state.text ? null : { failed: false, text: props.text };
  }

  render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

export default memo(function MarkdownContent({ children }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  return (
    <div className="markdown-body">
      {tooDeeplyNested(text) ? (
        <PlainText text={text} />
      ) : (
        <MarkdownBoundary text={text}>
          <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={markdownWebUrl}>
            {text}
          </ReactMarkdown>
        </MarkdownBoundary>
      )}
    </div>
  );
});
