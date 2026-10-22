/* selftest-scripts.mjs — ScriptsBackend.save 落盘路径安全：path 只当文件名用，
 * 绝对路径、../、"." / ".." 都不能把文件写到语料目录或 <工作目录>/scripts 之外。
 * 跑：node dev/selftest-scripts.mjs
 */
globalThis.ChromeUtils = globalThis.ChromeUtils || {
  importESModule: () => ({ setTimeout, clearTimeout }),
};
globalThis.PathUtils = {
  profileDir: "/profile",
  join: (...parts) => parts.map(String).filter(Boolean).join("/").replace(/\/{2,}/g, "/"),
  isAbsolute: p => String(p || "").startsWith("/"),
  filename: p => String(p).split(/[\\/]/).pop(),
};
const writes = [];
globalThis.IOUtils = {
  makeDirectory: async () => {},
  stat: async () => {
    throw new Error("not found");
  },
  writeUTF8: async path => void writes.push(path),
  write: async path => void writes.push(path),
};
globalThis.fetch = async url => ({
  status: 200,
  headers: { get: () => (/\.wasm$/.test(url) ? "application/wasm" : "text/javascript") },
  text: async () => "console.log('fixture');\n".repeat(100),
  arrayBuffer: async () => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer,
});

const { ScriptsBackend } = await import("../modules/ScriptsBackend.sys.mjs");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ " + msg);
  }
}

const CORPUS = "/profile/firefox-reverse-agent/js/";
const backend = new ScriptsBackend({ workspace: { getRoot: ctx => (ctx && ctx.workspaceRoot) || null } });
const ctx = { workspaceRoot: "/ws" };
const JS = "https://cdn.example.com/static/app.min.js";
const WASM = "https://cdn.example.com/static/sign.wasm";

async function savedPath(args, context) {
  const before = writes.length;
  const r = await backend.save(args, context);
  return { r, out: writes.length > before ? writes.at(-1) : null };
}

let res = await savedPath({ url: JS });
ok(res.out && res.out.startsWith(CORPUS), "默认落语料目录：" + res.out);

res = await savedPath({ url: JS, path: "/Users/victim/Library/LaunchAgents/x.plist" });
ok(res.out === CORPUS + "x.plist", "绝对路径只取文件名：" + res.out);

res = await savedPath({ url: JS, path: "../../../.zshrc" });
ok(res.out === CORPUS + ".zshrc", "../ 不能逃出语料目录：" + res.out);

res = await savedPath({ url: JS, path: "..\\..\\evil.js" });
ok(res.out === CORPUS + "evil.js", "Windows 反斜杠 ..\\ 同样只取文件名：" + res.out);

res = await savedPath({ url: JS, path: ".." });
ok(res.out && res.out.startsWith(CORPUS) && !res.out.endsWith("/.."), "\"..\" 回退为按 URL 生成的文件名：" + res.out);

res = await savedPath({ url: WASM, path: "/tmp/elsewhere/sign.wasm" });
ok(res.out === CORPUS + "sign.wasm" && res.r.binary === true, "二进制落盘同样只取文件名：" + res.out);

res = await savedPath({ url: JS, path: "../outside.js", toWorkspace: true }, ctx);
ok(res.out === "/ws/scripts/outside.js" && res.r.workspaceRelative === "scripts/outside.js", "toWorkspace 只落 <工作目录>/scripts：" + res.out);

res = await savedPath({ url: WASM, path: "..", toWorkspace: true }, ctx);
ok(res.out === "/ws/wasm/blob.bin", "toWorkspace 二进制 \"..\" 回退默认名：" + res.out);

ok(
  writes.every(p => p.startsWith(CORPUS) || p.startsWith("/ws/scripts/") || p.startsWith("/ws/wasm/")),
  "所有写入都在落盘目录内"
);

console.log(`\nScriptsBackend selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
