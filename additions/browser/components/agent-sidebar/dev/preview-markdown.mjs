// Run from this package with node dev/preview-markdown.mjs for visual QA.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({
  absWorkingDir: sidebar, entryPoints: ["dev/markdown-preview.jsx"],
  bundle: true, format: "iife", write: false,
});
const css = await readFile(new URL("../content/agent-panel.css", import.meta.url));
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Markdown preview</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>';
const server = http.createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundled.outputFiles[0].text);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else if (req.url === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(0, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
process.once("SIGTERM", () => { server.closeAllConnections(); server.close(); });
