import React, { Fragment, memo } from "react";
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

// 流式输出时，正在写的那一段每拍都在变长，整段重新解析的总开销随长度平方增长。这里把已经写完、后文不会
// 再改变其解析结果的部分切成块，各块单独渲染并缓存，每拍只重新解析最后一块。只在空行处切，并且要求：
// 不在代码围栏里；下一行顶格写，不是列表项，也不是以列表项开头的引用（否则可能还属于同一个列表或上一项）。
// 拿不准的结构出现后就不再往后切：以 "<" 开头的行（HTML 块里围栏和空行的规则都不同），以及外层引用或
// 列表项可能已经结束的围栏。有链接引用或脚注定义（定义写在后面也会影响前面的引用）、或单独的 \r 换行时
// 整段不切。块之间补一个换行，和整段渲染的输出一致。正则都不能有歧义的嵌套重复，否则长引用前缀会回溯爆炸。
const QUOTE_PREFIX = /^(?:[ ]{0,3}>[ \t]?)+/;
const LIST_MARKER = /^[ ]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const LIST_START = /^[ ]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const BLANK = /^[ \t]*$/; // CommonMark 只把空格和 tab 当空白，全角空格、不换行空格都算内容

function leadingWidth(s) {
  return s.length - s.replace(/^[ \t]+/, "").length;
}

function quoteDepth(line) {
  const prefix = QUOTE_PREFIX.exec(line);
  return prefix ? prefix[0].split(">").length - 1 : 0;
}

// 去掉行首的引用和列表标记：围栏、定义、HTML 都可能写在引用或列表项里。
function containerContent(line) {
  let rest = line.replace(QUOTE_PREFIX, "");
  for (let marker; (marker = LIST_MARKER.exec(rest)) && marker[0]; ) {
    rest = rest.slice(marker[0].length);
  }
  return rest;
}

export function streamingBlocks(text) {
  const whole = [{ start: 0, text }];
  if (/\r(?!\n)/.test(text)) {
    return whole;
  }
  const starts = [0];
  let fence = null;
  let frozen = false;
  let blank = false;
  let content = false;
  // 每拍都从头按当前文本重新判断，所以还没写完的最后半行也可以参与：它只决定这一拍怎么切。
  for (let lineStart = 0, next = 0; lineStart < text.length; lineStart = next) {
    const newline = text.indexOf("\n", lineStart);
    next = newline < 0 ? text.length : newline + 1;
    const line = text.slice(lineStart, newline < 0 ? text.length : newline).replace(/\r$/, "");
    if (fence && !frozen) {
      const body = fence.depth ? line.replace(QUOTE_PREFIX, "") : line;
      const quoteEnded = fence.depth > 0 && quoteDepth(line) !== fence.depth;
      if (quoteEnded || (!BLANK.test(body) && leadingWidth(body) < fence.column)) {
        frozen = true; // 外层的引用或列表项可能已经结束、围栏随之关闭，后面无法只凭逐行判断
      } else {
        const close = FENCE.exec(body);
        if (close && leadingWidth(body) - fence.column <= 3 && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length && BLANK.test(close[3])) {
          fence = null;
        }
        continue;
      }
    }
    const rest = containerContent(line);
    if (/^[ \t]*\[/.test(rest) && (rest.includes("]:") || !rest.includes("]"))) {
      return whole; // 链接引用或脚注定义（标签可能跨行）
    }
    if (frozen) {
      continue;
    }
    if (BLANK.test(line)) {
      blank = true;
      continue;
    }
    if (blank && content && !/^[ \t]/.test(line) && !LIST_START.test(line.replace(QUOTE_PREFIX, ""))) {
      starts.push(lineStart);
    }
    blank = false;
    content = true;
    if (/^[ \t]*</.test(rest)) {
      frozen = true;
      continue;
    }
    const open = FENCE.exec(rest);
    if (open && (open[2][0] === "~" || !open[3].includes("`"))) {
      const unquoted = line.replace(QUOTE_PREFIX, "");
      fence = { marker: open[2], depth: quoteDepth(line), column: unquoted.length - rest.length + open[1].replace(/\t/g, "    ").length };
    }
  }
  return starts.map((start, i) => ({ start, text: text.slice(start, starts[i + 1] ?? text.length) }));
}

const MarkdownBlock = memo(function MarkdownBlock({ text }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={markdownWebUrl}>
      {text}
    </ReactMarkdown>
  );
});

export default memo(function MarkdownContent({ children, streaming = false }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  return (
    <div className="markdown-body">
      {tooDeeplyNested(text) ? (
        <PlainText text={text} />
      ) : (
        <MarkdownBoundary text={text}>
          {streaming ? (
            streamingBlocks(text).map((block, i) => (
              <Fragment key={block.start}>
                {i ? "\n" : null}
                <MarkdownBlock text={block.text} />
              </Fragment>
            ))
          ) : (
            <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={markdownWebUrl}>
              {text}
            </ReactMarkdown>
          )}
        </MarkdownBoundary>
      )}
    </div>
  );
});
