/* selftest-jsvmp-backend.mjs — JsvmpBackend：
 *   ① trace 关 JIT 只改默认分支（不写 user 值、不落盘），没 stop 就退出时下次启动 JIT 自动恢复；
 *   ② 旧版本残留的三项 JIT user 值 false 只清一次，之后尊重用户自己的设置；
 *   ③ trace 镜像到工作目录使用调用方传入的会话 ctx。
 * 跑：node dev/selftest-jsvmp-backend.mjs
 */
const JIT = ["javascript.options.blinterp", "javascript.options.baselinejit", "javascript.options.ion"];
const HEALED = "extensions.firefox-reverse.jsvmp.jitPrefsHealed";

function makePrefs({ user = {}, defaults = {} } = {}) {
  const userValues = new Map(Object.entries(user));
  const defaultValues = new Map(Object.entries({ ...Object.fromEntries(JIT.map(k => [k, true])), ...defaults }));
  return {
    userValues,
    defaultValues,
    saved: 0,
    getBoolPref(k, def) {
      return userValues.has(k) ? userValues.get(k) : defaultValues.has(k) ? defaultValues.get(k) : def;
    },
    setBoolPref(k, v) {
      userValues.set(k, v);
    },
    prefHasUserValue(k) {
      return userValues.has(k);
    },
    clearUserPref(k) {
      userValues.delete(k);
    },
    getDefaultBranch(root) {
      return { setBoolPref: (k, v) => defaultValues.set(root + k, v) };
    },
    savePrefFile() {
      this.saved++;
    },
  };
}
globalThis.Services = { prefs: makePrefs(), appinfo: { OS: "Darwin" }, env: { get: () => "" } };

const { JsvmpBackend } = await import("../modules/JsvmpBackend.sys.mjs");

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
const effective = prefs => JIT.map(k => prefs.getBoolPref(k, true));

// ② 旧版本残留：三项都是 user 值 false → 构造时清掉一次
let prefs = (Services.prefs = makePrefs({ user: Object.fromEntries(JIT.map(k => [k, false])) }));
new JsvmpBackend();
ok(JIT.every(k => !prefs.prefHasUserValue(k)), "残留的 JIT user 值 false 被清掉");
ok(effective(prefs).every(Boolean), "清理后 JIT 生效值恢复为 true");
ok(prefs.getBoolPref(HEALED, false) === true, "记下已清理，不再重复");

for (const k of JIT) {
  prefs.setBoolPref(k, false); // 之后用户自己关 JIT
}
new JsvmpBackend();
ok(JIT.every(k => prefs.getBoolPref(k, true) === false), "已清理过一次后，尊重用户自己的 JIT 设置");

prefs = Services.prefs = makePrefs({ user: { "javascript.options.ion": false } });
new JsvmpBackend();
ok(prefs.getBoolPref("javascript.options.ion", true) === false, "只有单项 false 不视为残留，不动");

// ① trace start/stop 只改默认分支
prefs = Services.prefs = makePrefs();
const backend = new JsvmpBackend();
backend._setJit(false);
ok(JIT.every(k => prefs.defaultValues.get(k) === false), "start：默认分支关 JIT");
ok(JIT.every(k => !prefs.prefHasUserValue(k)), "start：不写 user 值（不会进 prefs.js）");
ok(prefs.saved === 0, "start：不强制落盘");
backend._setJit(true);
ok(JIT.every(k => prefs.defaultValues.get(k) === true) && effective(prefs).every(Boolean), "stop：恢复默认 JIT");

prefs = Services.prefs = makePrefs({ user: { "javascript.options.baselinejit": false } });
new JsvmpBackend()._setJit(true);
ok(!prefs.prefHasUserValue("javascript.options.baselinejit"), "stop：顺带清掉会盖住默认分支的 user 值");

// ③ 镜像到工作目录用会话 ctx
const copies = [];
globalThis.PathUtils = {
  join: (...parts) => parts.join("/"),
  filename: p => String(p).split("/").pop(),
};
globalThis.IOUtils = {
  stat: async p => {
    if (p.startsWith("/ws/")) {
      throw new Error("not found");
    }
    return { size: 10, lastModified: 1 };
  },
  makeDirectory: async () => {},
  copy: async (src, dest) => void copies.push([src, dest]),
};
const relay = new JsvmpBackend({ getWorkspaceRoot: ctx => (ctx && ctx.workspaceRoot) || null });
const trace = "/tmp/firefox-reverse-jsvmp-b.ndjson.123";
const dest = await relay._relayToWorkspace(trace, { workspaceRoot: "/ws" });
ok(dest === "/ws/jsvmp/firefox-reverse-jsvmp-b.ndjson.123", "按会话工作目录镜像：" + dest);
ok(copies.length === 1 && copies[0][0] === trace, "确实拷贝了 trace 文件");
ok((await relay._relayToWorkspace(trace)) === null, "没有工作目录时不镜像");

console.log(`\nJsvmpBackend selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
