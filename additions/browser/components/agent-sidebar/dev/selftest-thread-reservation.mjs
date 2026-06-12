/* dev/selftest-thread-reservation.mjs — 多窗口线程预留逻辑的算法规格镜像测试。
 *   node dev/selftest-thread-reservation.mjs
 * AgentSession.sys.mjs 依赖整棵 Firefox 模块树、Node 无法直接 import，故此处**逐字镜像**
 * acquire/renew/release 三函数的算法，覆盖回归点：同 owner 立即重认领 / 别窗口活预留拦截 /
 * 预留过期回收 / 心跳续约 / 释放只放自己的。真模块的端到端验证走装机后 marionette aeval。
 * 不随 omni.ja 打包。
 */
const RESERVE_TTL_MS = 8000;

// ── 逐字镜像自 AgentSession.sys.mjs（改动时两处同步）──
function makeStore() {
  const sessions = new Map();
  let NOW = 0;
  const now = () => NOW;
  const getOrInit = id => {
    let s = sessions.get(id);
    if (!s) {
      s = { reservation: null };
      sessions.set(id, s);
    }
    return s;
  };
  return {
    sessions,
    advance: ms => {
      NOW += ms;
    },
    setNow: v => {
      NOW = v;
    },
    acquireThread(candidateIds, owner) {
      const token = owner || "anon";
      for (const id of candidateIds || []) {
        if (!id) {
          continue;
        }
        const s = getOrInit(id);
        const r = s.reservation;
        const liveOther = r && r.owner !== token && now() - r.ts < RESERVE_TTL_MS;
        if (!liveOther) {
          s.reservation = { owner: token, ts: now() };
          return id;
        }
      }
      return null;
    },
    renewThread(threadId, owner) {
      const s = sessions.get(threadId);
      if (!s) {
        return false;
      }
      const token = owner || "anon";
      if (!s.reservation) {
        s.reservation = { owner: token, ts: now() };
        return true;
      }
      if (s.reservation.owner !== token) {
        return false;
      }
      s.reservation.ts = now();
      return true;
    },
    releaseThread(threadId, owner) {
      const s = sessions.get(threadId);
      if (!s || !s.reservation) {
        return;
      }
      if (owner && s.reservation.owner !== owner) {
        return;
      }
      s.reservation = null;
    },
  };
}

let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: got=${JSON.stringify(got)}${ok ? "" : " want=" + JSON.stringify(want)}`);
  if (!ok) {
    fail++;
  }
}

// 1) 基本认领
let st = makeStore();
check("首次认领成功", st.acquireThread(["T"], "winA"), "T");

// 2) 别的活窗口认领不到（多窗口隔离仍生效）
check("别窗口被拦", st.acquireThread(["T"], "winB"), null);

// 3) ★核心修复：同窗口(同 owner)重挂载立即重认领——不受 TTL 影响（切栏回来场景）
check("同 owner 立即重认领", st.acquireThread(["T"], "winA"), "T");

// 4) ★核心修复：持有者销毁未释放（无心跳），预留过期后别窗口可回收
st = makeStore();
st.acquireThread(["T"], "dead-mount"); // 旧挂载认领后文档被异常拆除，没 release
st.advance(RESERVE_TTL_MS + 1); // 过 TTL 无续约
check("过期预留可被新窗口回收", st.acquireThread(["T"], "new-mount"), "T");

// 5) 心跳续约：活窗口持续 renew → 始终不被别窗口抢
st = makeStore();
st.acquireThread(["T"], "winA");
for (let i = 0; i < 10; i++) {
  st.advance(3000); // 每 3s 一次心跳，10 次跨度 30s >> TTL
  check(`心跳第${i + 1}次续约`, st.renewThread("T", "winA"), true);
  // 期间别窗口始终抢不到
  if (st.acquireThread(["T"], "winB") !== null) {
    console.log("FAIL 心跳期间别窗口竟抢到");
    fail++;
  }
}

// 6) renew 对已被别窗口接管的预留返回 false（不抢回）
st = makeStore();
st.acquireThread(["T"], "winA");
st.advance(RESERVE_TTL_MS + 1);
st.acquireThread(["T"], "winB"); // winA 过期，winB 合法接管
check("renew 不抢回已接管的预留", st.renewThread("T", "winA"), false);
check("接管方 renew 正常", st.renewThread("T", "winB"), true);

// 7) release 只放自己的预留
st = makeStore();
st.acquireThread(["T"], "winA");
st.releaseThread("T", "winB"); // 别窗口试图释放——应无效
check("release 不放别窗口的预留", st.acquireThread(["T"], "winC"), null);
st.releaseThread("T", "winA"); // 自己释放
check("release 自己的预留后可被认领", st.acquireThread(["T"], "winC"), "T");

// 8) 旧式无 owner 调用兼容（anon 视为同一匿名 owner）
st = makeStore();
check("无 owner 认领", st.acquireThread(["T"]), "T");
check("无 owner 重认领(anon 同源)", st.acquireThread(["T"]), "T");
st.releaseThread("T"); // 无 owner 无条件释放
check("无 owner 释放后认领", st.acquireThread(["T"], "winX"), "T");

// 9) 多候选：跳过被占的，认领第一个可用的
st = makeStore();
st.acquireThread(["A"], "winA"); // A 被 winA 占
const got = st.acquireThread(["A", "B"], "winB"); // A 被活占 → 取 B
check("多候选跳过被占取下一个", got, "B");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
