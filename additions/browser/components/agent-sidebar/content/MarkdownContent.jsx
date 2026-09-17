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

export default memo(function MarkdownContent({ children }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={markdownWebUrl}>
        {typeof children === "string" ? children : String(children ?? "")}
      </ReactMarkdown>
    </div>
  );
});
