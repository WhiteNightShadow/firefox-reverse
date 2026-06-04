/* selftest-workspace.mjs — WorkspaceBackend 路径安全（越界拒绝）单测。
 * Node 下无 IOUtils/Subprocess，只测纯逻辑 _resolve/_assertRoot（安全关键）。
 * 跑：node dev/selftest-workspace.mjs
 */
// 最小 mock：_resolve 对合法相对路径会调 PathUtils.join。
globalThis.PathUtils = globalThis.PathUtils || {
  join: (...a) => a.join("/"),
  filename: p => String(p).split("/").pop(),
  parent: p => String(p).split("/").slice(0, -1).join("/"),
};

const { WorkspaceBackend } = await import("../modules/WorkspaceBackend.sys.mjs");

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
function throws(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, msg);
}

console.log("[1] 未设根 → 报错 / info set:false");
const w = new WorkspaceBackend();
throws(() => w._resolve("a"), "未设工作目录 → _resolve 抛错");
const info = await w.info();
ok(info.set === false && info.root === null, "info(): set=false root=null");

console.log("[2] 设根 + 合法相对路径解析");
w.setRoot("/ws/proj");
ok(w.getRoot() === "/ws/proj", "getRoot=/ws/proj");
ok(w._resolve("a/b.js") === "/ws/proj/a/b.js", "相对路径 a/b.js → /ws/proj/a/b.js");
ok(w._resolve("") === "/ws/proj", "空路径 → 根");
ok(w._resolve(".") === "/ws/proj", "'.' → 根");
ok(w._resolve("./sub/x") === "/ws/proj/sub/x", "'./sub/x' → 根内");

console.log("[3] 越界一律拒绝（安全关键）");
throws(() => w._resolve("../etc"), "../etc 拒绝");
throws(() => w._resolve("a/../../b"), "a/../../b 拒绝（含 ..）");
throws(() => w._resolve("/etc/passwd"), "绝对路径 /etc/passwd 越界拒绝");
throws(() => w._resolve("/ws/proj/../etc"), "/ws/proj/../etc 拒绝（含 ..）");

console.log("[4] 绝对路径在根内 → 允许");
ok(w._resolve("/ws/proj/sub/x.js") === "/ws/proj/sub/x.js", "根内绝对路径放行");
ok(w._resolve("/ws/proj") === "/ws/proj", "等于根 → 放行");
// 前缀相近但不在根内（/ws/proj-evil）必须拒绝
throws(() => w._resolve("/ws/proj-evil/x"), "前缀相近的 /ws/proj-evil 拒绝（非子目录）");

console.log("[5] runNode/runPython 在 Node 下因无 Subprocess 报错（不静默成功）");
let runErr = false;
try {
  await w.runNode({ code: "1" });
} catch {
  runErr = true;
}
ok(runErr, "Node 环境 runNode 抛错（Subprocess 不可用）");

console.log(`\nworkspace selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
