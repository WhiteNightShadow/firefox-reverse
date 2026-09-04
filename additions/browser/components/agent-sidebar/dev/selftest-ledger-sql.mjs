/* selftest-ledger-sql.mjs — LedgerBackend 作用域 SQL 与去重删除安全回归。
 * 跑：node dev/selftest-ledger-sql.mjs
 */
import {
  LedgerBackend,
  ledgerDeleteByIdsSql,
  ledgerScopeSql,
} from "../modules/LedgerBackend.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};

function row(values) {
  return { getResultByName: name => values[name] };
}

function fakeDb(existing = []) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      return sql.startsWith("SELECT id,norm FROM mem") ? existing : [];
    },
  };
}

async function addWith({ workspaceRoot = "", site = "", existing = [], text = "已确认的签名入口" } = {}) {
  const db = fakeDb(existing);
  const ledger = new LedgerBackend();
  ledger._db = async () => db;
  ledger._renderMd = async () => {};
  ledger.currentSite = () => site;
  await ledger._addMany([{ kind: "fact", text }], { workspaceRoot });
  return db.calls;
}

console.log("[1] workspace/site 使用完整 SQL allowlist");
const wsSql = ledgerScopeSql("workspace");
const siteSql = ledgerScopeSql("site");
ok(wsSql.selectExisting.includes("workspace=:v") && !wsSql.selectExisting.includes("site=:v"), "workspace 分支选择固定 SQL");
ok(siteSql.selectExisting.includes("site=:v") && !siteSql.selectExisting.includes("workspace=:v"), "site 分支选择固定 SQL");
ok(wsSql.trimOldest.includes("workspace=:v") && siteSql.trimOldest.includes("site=:v"), "两分支封顶删除也来自固定 SQL");

console.log("[2] 未知列 fail-closed");
let unknownRejected = false;
try {
  ledgerScopeSql("workspace OR 1=1; DROP TABLE mem;--");
} catch {
  unknownRejected = true;
}
ok(unknownRejected, "未知/恶意列名在执行前拒绝");

console.log("[3] 外部 workspace/site 值只走绑定参数");
const evilWorkspace = "/tmp/ws'); DROP TABLE mem;--";
const workspaceCalls = await addWith({ workspaceRoot: evilWorkspace, site: "ignored.example" });
ok(workspaceCalls.every(call => !call.sql.includes(evilWorkspace)), "workspace payload 不进入 SQL 文本");
ok(workspaceCalls.some(call => call.params?.v === evilWorkspace), "workspace payload 通过 :v 绑定");
ok(workspaceCalls.some(call => call.params?.w === evilWorkspace), "workspace INSERT 继续使用绑定参数");

const evilSite = "example.test' OR 1=1;--";
const siteCalls = await addWith({ site: evilSite });
ok(siteCalls.every(call => !call.sql.includes(evilSite)), "site payload 不进入 SQL 文本");
ok(siteCalls.some(call => call.params?.v === evilSite), "site payload 通过 :v 绑定");
ok(siteCalls.some(call => call.params?.s === evilSite), "site INSERT 继续使用绑定参数");

console.log("[4] dropIds 使用固定占位符 SQL");
const text = "这是用于触发账本去重的相同文本";
const evilId = "7); DROP TABLE mem;--";
const dropCalls = await addWith({
  workspaceRoot: "/safe/workspace",
  text,
  existing: [
    row({ id: evilId, norm: "这是用于触发账本去重的相同文本" }),
    row({ id: 8, norm: "这是用于触发账本去重的相同文本" }),
  ],
});
const deleteByIds = dropCalls.find(call => call.sql.startsWith("DELETE FROM mem WHERE id IN"));
ok(deleteByIds?.sql === "DELETE FROM mem WHERE id IN (?,?)", "多 ID 去重使用单条占位符 SQL");
ok(JSON.stringify(deleteByIds?.params) === JSON.stringify([evilId, 8]), "全部 drop id 作为数组参数一次绑定");
ok(dropCalls.every(call => !call.sql.includes(evilId)), "恶意 drop id 不进入 SQL 文本");
ok(dropCalls.filter(call => call.sql === ledgerDeleteByIdsSql(2)).length === 1, "批量去重只执行一条语句");
ok(ledgerDeleteByIdsSql(3) === "DELETE FROM mem WHERE id IN (?,?,?)", "占位符数量由整数 count 唯一决定");
for (const badCount of [0, -1, 1.5, NaN, Infinity]) {
  let rejected = false;
  try {
    ledgerDeleteByIdsSql(badCount);
  } catch {
    rejected = true;
  }
  ok(rejected, `非法 count ${String(badCount)} 在生成 SQL 前拒绝`);
}

console.log(`\nledger SQL selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
