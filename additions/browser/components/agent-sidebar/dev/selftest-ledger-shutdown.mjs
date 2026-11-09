/* selftest-ledger-shutdown.mjs — 退出浏览器时关闭记忆库（memory.sqlite）的连接。
 * 连接不关的话，Sqlite.sys.mjs 在 profile-before-change 一直等，60 秒后 AsyncShutdown 超时崩溃。
 * 这里用假的 Sqlite/IOUtils/PathUtils，不启动浏览器。跑：node dev/selftest-ledger-shutdown.mjs
 */
import assert from "node:assert/strict";
import { LedgerBackend } from "../modules/LedgerBackend.sys.mjs";

let pass = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  pass++;
  console.log("  ✓", message);
};

/** 假的 Sqlite.sys.mjs：记录打开的连接、登记的退出回调和执行过的语句。 */
function install({ lateShutdown = false, holdFirstStatement = false } = {}) {
  const state = { opened: 0, closed: 0, blockers: [], statements: [], release: null };
  const connection = {
    async execute(sql) {
      state.statements.push(sql);
      if (holdFirstStatement && state.statements.length === 1) {
        await new Promise(resolve => {
          state.release = resolve;
        });
      }
      return [];
    },
    async close() {
      state.closed++;
    },
  };
  globalThis.ChromeUtils = {
    importESModule: () => ({
      Sqlite: {
        async openConnection() {
          state.opened++;
          return connection;
        },
        shutdown: {
          addBlocker(name, blocker) {
            if (lateShutdown) {
              throw new Error("Phase is finished, it is too late to register completion condition");
            }
            state.blockers.push({ name, blocker });
          },
        },
      },
    }),
  };
  globalThis.PathUtils = { profileDir: "/profile", join: (...parts) => parts.join("/") };
  globalThis.IOUtils = { makeDirectory: async () => {}, writeUTF8: async () => {} };
  return state;
}
const ctx = { workspaceRoot: "/workspace" };

console.log("[1] 打开时登记退出回调，回调关闭连接");
{
  const state = install();
  const ledger = new LedgerBackend();
  check((await ledger.digest({}, ctx)) === "", "空记忆库的摘要是空串");
  check(state.opened === 1 && state.blockers.length === 1, "第一次用到时打开连接，并登记一个退出回调");
  check(state.blockers[0].name.includes("memory.sqlite"), "回调的名字写明是哪个库（退出卡住时能从崩溃信息里认出来）");
  await ledger.recall({ query: "x" }, ctx);
  check(state.opened === 1 && state.blockers.length === 1, "之后复用同一个连接，不重复登记");
  await state.blockers[0].blocker();
  check(state.closed === 1, "退出回调关闭连接");

  console.log("[2] 关闭之后不再重开");
  const before = state.statements.length;
  check((await ledger.digest({}, ctx)) === "", "摘要照旧返回空串，不报错");
  await assert.rejects(() => ledger.recall({ query: "x" }, ctx), /记忆库已关闭/);
  check(true, "检索明确报「记忆库已关闭」");
  await assert.rejects(() => ledger.append({ text: "已确认的签名入口" }, ctx), /记忆库已关闭/);
  check(true, "写入同样报错，不会悄悄丢掉");
  check((await ledger.mergeHandoff("## 已确认事实\n- 一条事实", ctx)).ok === false, "压缩时的自动沉淀返回失败，不抛错");
  check(state.opened === 1 && state.statements.length === before, "没有重开连接，也没有再执行语句");
}

console.log("[3] 登记不上（浏览器已经在退出）");
{
  const state = install({ lateShutdown: true });
  const ledger = new LedgerBackend();
  await assert.rejects(() => ledger.recall({ query: "x" }, ctx), /记忆库已关闭/);
  check(state.opened === 1 && state.closed === 1 && state.statements.length === 0, "刚打开的连接立刻关掉，不建表");
  check((await ledger.digest({}, ctx)) === "" && state.opened === 1, "之后不再重开");
}

console.log("[4] 建表期间开始退出");
{
  const state = install({ holdFirstStatement: true });
  const ledger = new LedgerBackend();
  const pending = ledger.recall({ query: "x" }, ctx);
  while (!state.release) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await state.blockers[0].blocker();
  state.release();
  await assert.rejects(() => pending, /记忆库已关闭/);
  check(state.closed === 1, "建表中途收到退出回调：连接已关，这次调用报错");
  await assert.rejects(() => ledger.recall({ query: "x" }, ctx), /记忆库已关闭/);
  check(state.opened === 1, "关掉的连接不会被留下来接着用");
}

console.log(`\nledger shutdown selftest: ${pass} passed`);
