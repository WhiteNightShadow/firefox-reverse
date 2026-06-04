/* Phase B JSVMP trace core implementation. */

#include "vm/JsvmpTraceCore.h"

#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
// 跨平台 trace 目录 + pid：mac/Linux 路径/行为**完全不变**（仍 /tmp、getpid）；仅 Windows 走新分支
// （无 /tmp → 用系统 TEMP，与 JS 侧 Services.env.get("TEMP") 同源，保证 C++/JS 两进程算出同一路径）。
#ifdef XP_WIN
#  include <process.h>  // _getpid
static inline int FrxPid() { return _getpid(); }
static inline const char* FrxTraceDir() {
  const char* t = getenv("TEMP");
  if (!t || !t[0]) t = getenv("TMP");
  if (!t || !t[0]) t = "C:\\Windows\\Temp";
  return t;
}
#else
#  include <unistd.h>  // getpid
static inline int FrxPid() { return getpid(); }
static inline const char* FrxTraceDir() { return "/tmp"; }
#endif
#include <sys/stat.h>  // stat（ctl mtime 自动过期）

#include "js/ColumnNumber.h"      // JS::LimitedColumnNumberOneOrigin
#include "js/CharacterEncoding.h" // JS_EncodeStringToUTF8
#include "js/Array.h"             // JS::IsArrayObject, JS::GetArrayLength
#include "js/Id.h"                // JS::PropertyKey (jsid)
#include "js/PropertyAndElement.h"// JS_GetPropertyById, JS_GetElement
#include "jsfriendapi.h"          // js::GetPropertyKeys, JSITER_OWNONLY
#include "vm/BytecodeUtil.h"      // CodeName(JSOp) 字符串
#include "vm/EnvironmentObject.h" // js::EnvironmentObject::enclosingEnvironment（闭包链）
#include "vm/FrameIter.h"         // js::FrameIter for arg dump
#include "vm/JSScript.h"          // JSScript::filename, JSScript::code, PCToLineNumber
#include "vm/Stack.h"             // js::AbstractFramePtr
#include "jit/JitOptions.h"       // js::jit::JitOptions（trace 期间钉死解释器层，hook 才抓得到热函数）

namespace mozilla {
namespace jsvmp {

// 全局热路径标志：hot path 只 check 这一个 bool
bool gTraceEnabled = false;

namespace {

// 初始化状态
std::atomic<bool> gInitDone{false};

// 输出文件 + mutex（多线程 Interpret 安全；Content process 一般单 main thread
// 跑 JS，但 worker thread / OffThread JIT 也可能进入 Interpret）
std::mutex gWriteMutex;
FILE* gOutFile = nullptr;
const char* gScriptFilter = nullptr;
uint64_t gMaxRecords = 1000000;  // 1M lines 默认上限
std::atomic<uint64_t> gRecordCount{0};
// 达到上限后置位：防止运行期轮询把"已达上限而停"的 trace 当成"未启用"重新启用+清零计数，
// 造成 cap→停→轮询复活→清零→再 cap 的无限循环（曾导致 4GB / 5500 万行）。
// 仅显式 stop(ctl=0) 或换 filter 时解除。
bool gLimitReached = false;
// filter 变更计数：filter 改变时 +1，让各线程的 filter 缓存失效（支持运行期换 filter）
std::atomic<uint32_t> gFilterVersion{0};

// ── 关键：把 JIT 各层 warmup 阈值拉满，让函数永不 tier-up 出 js::Interpret ──
// hook 只在 js::Interpret(tier-0) 的 ADVANCE_AND_DISPATCH 里；函数热了(默认~10 次)就升到
// Baseline Interpreter/JIT/Ion → 逃出 hook → 热 dispatcher 抓不到（实测 Gecko 的
// javascript.options.* pref 同步到内容进程不生效）。这里直接改本进程内的 js::jit::JitOptions
// （trace 就跑在内容进程里），把阈值设成 UINT32_MAX → 实际永不升层 → 全程 tier-0 → hook 必中。
// 仅 trace 期间生效，stop 还原，不影响平时浏览。对 reload 后的"冷"目标最有效（已 JIT 的旧代码
// 需 reload 重新冷加载才会落回 tier-0）。通用：对任意站点的 JSVMP dispatcher 都成立。
bool gJitPinned = false;
uint32_t gSavedBlinterpThr = 0, gSavedBaselineThr = 0, gSavedIonThr = 0;
void PinInterpreterTier() {
  if (gJitPinned) {
    return;
  }
  gSavedBlinterpThr = js::jit::JitOptions.baselineInterpreterWarmUpThreshold;
  gSavedBaselineThr = js::jit::JitOptions.baselineJitWarmUpThreshold;
  gSavedIonThr = js::jit::JitOptions.normalIonWarmUpThreshold;
  js::jit::JitOptions.baselineInterpreterWarmUpThreshold = UINT32_MAX;
  js::jit::JitOptions.baselineJitWarmUpThreshold = UINT32_MAX;
  js::jit::JitOptions.normalIonWarmUpThreshold = UINT32_MAX;
  gJitPinned = true;
  fprintf(stderr, "[jsvmp-trace-B] JIT tiers pinned to interpreter (reload target to capture)\n");
}
void RestoreJitTiers() {
  if (!gJitPinned) {
    return;
  }
  js::jit::JitOptions.baselineInterpreterWarmUpThreshold = gSavedBlinterpThr;
  js::jit::JitOptions.baselineJitWarmUpThreshold = gSavedBaselineThr;
  js::jit::JitOptions.normalIonWarmUpThreshold = gSavedIonThr;
  gJitPinned = false;
}

// thread_local 标记：本线程是否已写过某 script 的 meta 行
// 避免每次都重复写 filename
thread_local std::unordered_set<JSScript*>* tlsSeenScripts = nullptr;

// thread_local: script -> filter-match cache
// 避免每个 op 都重复 strstr filename
// 状态: 0 = unknown, 1 = match, 2 = no-match
thread_local std::unordered_map<JSScript*, uint8_t>* tlsFilterCache = nullptr;
thread_local uint32_t tlsFilterVersion = 0;  // 本线程缓存对应的 gFilterVersion

// dump_args 配置
bool gDumpArgsEnabled = false;
uint32_t gDumpArgsCol = 0;          // 0 = any column
uint64_t gDumpArgsLimit = 100;
std::atomic<uint64_t> gDumpArgsCount{0};

// dump_locals 配置 (Phase B.4)：在指定 (col, pc) dump 帧局部变量 + （可选）闭包/环境链
// 通用：拿 JSVMP 运行时常量(如某些 VM 的 xor key 闭包对象)，
// 静态分析拿不到的值靠这个动态 dump。
bool gDumpLocalsEnabled = false;
uint32_t gDumpLocalsCol = 0;        // 0 = any column
uint32_t gDumpLocalsPc = 0;         // 触发的 pc 偏移（默认 0 = 函数入口）
uint64_t gDumpLocalsLimit = 50;
uint64_t gDumpLocalsSkip = 0;       // 跳过前 N 次触发（拿执行末尾，如输出串已成型）
std::atomic<uint64_t> gDumpLocalsCount{0};
bool gDumpEnvEnabled = false;       // 是否同时 walk 环境链（闭包变量）
int gDumpDepth = 2;                 // 对象/数组序列化深度
uint32_t gDumpMaxArr = 2048;        // 数组/对象键序列化上限（字符串池等大数组用，可调）

// vpc_trace 配置（Phase B.5）：在指定 (col, pc) 每次命中都轻量快照「帧数值寄存器」
// 通用：JSVMP 派发循环头每跑一条虚拟指令就记一行寄存器值 → 离线找出哪个槽是虚拟 pc，
// 据此补全静态反汇编里解不出的跳转目标。不写死任何站点/槽号，槽语义全靠离线数据分析。
bool gVpcEnabled = false;
uint32_t gVpcCol = 0;               // dispatcher 列（0=任意）
uint32_t gVpcPc = 0;                // 触发 pc 偏移（= 派发循环头，离线从 trace 找）
uint64_t gVpcLimit = 200000;        // 最多记录条数（每条 = 一次虚拟指令）
std::atomic<uint64_t> gVpcCount{0};

// dump_ret 配置（Phase B.6）：在 JS 函数返回(RetRval/Return)处 dump 返回值。
// 通用：递归 VM 的最外层返回值常是最终产物(如最终签名串)。SKIP 跳到最后一次返回=最外层。
// 不写死站点：col 标 dispatcher 函数，SKIP/LIMIT 控制取第几次返回。
bool gDumpRetEnabled = false;
uint32_t gDumpRetCol = 0;
uint64_t gDumpRetLimit = 50;
uint64_t gDumpRetSkip = 0;
std::atomic<uint64_t> gDumpRetCount{0};

uint64_t NowNanos() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000000000ULL + uint64_t(ts.tv_nsec);
}

// JSON 字符串转义（必要字符）
void WriteJsonEscaped(FILE* f, const char* s) {
  fputc('"', f);
  for (; *s; ++s) {
    unsigned char c = (unsigned char)*s;
    switch (c) {
      case '"':  fputs("\\\"", f); break;
      case '\\': fputs("\\\\", f); break;
      case '\n': fputs("\\n", f); break;
      case '\r': fputs("\\r", f); break;
      case '\t': fputs("\\t", f); break;
      default:
        if (c < 0x20) {
          fprintf(f, "\\u%04x", c);
        } else {
          fputc(c, f);
        }
        break;
    }
  }
  fputc('"', f);
}

// 运行期按需打开输出文件（env 启动路径仍走 EnsureInit 内联打开；二者以 gOutFile 为准、不重复开）。
bool OpenOutputFileIfNeeded() {
  if (gOutFile) {
    return true;
  }
  const char* basePath = getenv("MOZ_JSVMP_TRACE_FILE");
  char baseBuf[1024];
  if (!basePath || !basePath[0]) {
    snprintf(baseBuf, sizeof(baseBuf), "%s/firefox-reverse-jsvmp-b.ndjson", FrxTraceDir());
    basePath = baseBuf;
  }
  char fullPath[1024];
  snprintf(fullPath, sizeof(fullPath), "%s.%d", basePath, FrxPid());
  gOutFile = fopen(fullPath, "w");
  if (!gOutFile) {
    fprintf(stderr, "[jsvmp-trace-B] (runtime) failed to open %s: %s\n", fullPath,
            strerror(errno));
    return false;
  }
  setvbuf(gOutFile, nullptr, _IOLBF, 0);
  fprintf(gOutFile,
          "{\"_meta\":{\"version\":\"phase-b.0\",\"pid\":%d,\"started_ns\":%llu,"
          "\"filter\":\"%s\",\"limit\":%llu,\"runtime\":1}}\n",
          FrxPid(), (unsigned long long)NowNanos(),
          gScriptFilter ? gScriptFilter : "", (unsigned long long)gMaxRecords);
  fflush(gOutFile);
  return true;
}

// ── 运行期 dump 配置（Agent 通过 jsvmp_trace 的 actions 在运行期开 locals/env/vpc/ret/args）──
// 修掉原本 dump_* 只能在**启动期 env** 生效、装机浏览器运行期打不开的缺陷（schema 里 actions
// 一直是死参数）。这正是"抓不到 JSVMP 运行期常量/闭包对象"的关键缺口：dump_env 能深序列化常量
// 闭包对象，但以前接不到运行期开关上。配置文件按 pid 区分(<base>.<pid>，只配当前标签内容进程，
// 防后台进程串扰)，每行一个模式 + 空格分隔 k=v：
//   locals col=2941 pc=0 env=1 limit=50 skip=0 depth=3 maxarr=2048
//   vpc col=2941 pc=56 limit=200000
//   ret col=2941 limit=50 skip=10
//   args col=0 limit=100
// 内容为 "off"/空 → 全部关。spec 原文未变则跳过(不每轮重置计数)。通用，无站点信息。
bool DumpKV(const char* line, const char* key, uint64_t* out) {
  const char* p = strstr(line, key);
  if (!p) return false;
  *out = strtoull(p + strlen(key), nullptr, 10);
  return true;
}
void MaybeApplyDumpConfig() {
  const char* dEnv = getenv("MOZ_JSVMP_DUMP_CTL");
  char dBaseBuf[1024];
  if (!(dEnv && dEnv[0])) {
    snprintf(dBaseBuf, sizeof(dBaseBuf), "%s/firefox-reverse-jsvmp.dump", FrxTraceDir());
  }
  const char* dBase = (dEnv && dEnv[0]) ? dEnv : dBaseBuf;
  char path[1088];
  snprintf(path, sizeof(path), "%s.%d", dBase, FrxPid());
  FILE* f = fopen(path, "rb");
  if (!f) {
    return;  // 无文件 → 不动 dump 状态（保留 env 启动期配置）
  }
  char buf[4096];
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  buf[n] = '\0';
  static std::string gLastDumpSpec;
  std::string spec(buf);
  if (spec == gLastDumpSpec) {
    return;  // 未变 → 跳过
  }
  gLastDumpSpec = spec;

  std::lock_guard<std::mutex> lock(gWriteMutex);
  // spec 全量定义 dump 状态：先全关，再逐行开（移除某行 = 关该模式）
  gDumpLocalsEnabled = false;
  gDumpEnvEnabled = false;
  gVpcEnabled = false;
  gDumpRetEnabled = false;
  gDumpArgsEnabled = false;
  size_t i = 0;
  while (i < spec.size()) {
    size_t e = spec.find('\n', i);
    if (e == std::string::npos) {
      e = spec.size();
    }
    std::string line = spec.substr(i, e - i);
    i = e + 1;
    const char* L = line.c_str();
    uint64_t v;
    if (!strncmp(L, "locals", 6)) {
      gDumpLocalsEnabled = true;
      gDumpLocalsCol = DumpKV(L, "col=", &v) ? (uint32_t)v : 0;
      gDumpLocalsPc = DumpKV(L, "pc=", &v) ? (uint32_t)v : 0;
      gDumpLocalsLimit = DumpKV(L, "limit=", &v) ? v : 50;
      gDumpLocalsSkip = DumpKV(L, "skip=", &v) ? v : 0;
      gDumpEnvEnabled = DumpKV(L, "env=", &v) ? (v != 0) : false;
      gDumpDepth = DumpKV(L, "depth=", &v) ? (int)v : 2;
      gDumpMaxArr = (DumpKV(L, "maxarr=", &v) && v > 0) ? (uint32_t)v : 2048;
      gDumpLocalsCount.store(0, std::memory_order_relaxed);
    } else if (!strncmp(L, "vpc", 3)) {
      gVpcEnabled = true;
      gVpcCol = DumpKV(L, "col=", &v) ? (uint32_t)v : 0;
      gVpcPc = DumpKV(L, "pc=", &v) ? (uint32_t)v : 0;
      gVpcLimit = DumpKV(L, "limit=", &v) ? v : 200000;
      gVpcCount.store(0, std::memory_order_relaxed);
    } else if (!strncmp(L, "ret", 3)) {
      gDumpRetEnabled = true;
      gDumpRetCol = DumpKV(L, "col=", &v) ? (uint32_t)v : 0;
      gDumpRetLimit = DumpKV(L, "limit=", &v) ? v : 50;
      gDumpRetSkip = DumpKV(L, "skip=", &v) ? v : 0;
      gDumpRetCount.store(0, std::memory_order_relaxed);
    } else if (!strncmp(L, "args", 4)) {
      gDumpArgsEnabled = true;
      gDumpArgsCol = DumpKV(L, "col=", &v) ? (uint32_t)v : 0;
      gDumpArgsLimit = DumpKV(L, "limit=", &v) ? v : 100;
      gDumpArgsCount.store(0, std::memory_order_relaxed);
    }
    // "off"/空行 → 不开任何（已全关）
  }
  fprintf(stderr,
          "[jsvmp-trace-B] dump config via %s: locals=%d env=%d vpc=%d ret=%d args=%d\n",
          path, (int)gDumpLocalsEnabled, (int)gDumpEnvEnabled, (int)gVpcEnabled,
          (int)gDumpRetEnabled, (int)gDumpArgsEnabled);
}

// 运行期开关：Agent(chrome JS)用 IOUtils 写控制文件来 start/stop trace，无需重启浏览器、不碰 Gecko prefs。
// 摊销：EnsureInit 每次进解释器都调本函数；每 256 次才真读文件（trace 关闭时也轮询，故能被重新打开）。
// 控制文件格式：首字节 '1' 开 / '0' 关；可选第二行 = script filename 过滤子串。
void MaybePollControlFile() {
  static std::atomic<uint32_t> pollCounter{0};
  if ((pollCounter.fetch_add(1, std::memory_order_relaxed) & 0xFF) != 0) {
    return;
  }
  const char* ctlEnv = getenv("MOZ_JSVMP_TRACE_CTL");
  // per-PID ctl：每个内容进程各自的控制文件，多会话/多标签页互不干扰。
  char ctlBuf[256];
  if (ctlEnv && ctlEnv[0]) {
    strncpy(ctlBuf, ctlEnv, sizeof(ctlBuf) - 1);
    ctlBuf[sizeof(ctlBuf) - 1] = '\0';
  } else {
    snprintf(ctlBuf, sizeof(ctlBuf), "%s/firefox-reverse-jsvmp.ctl.%d", FrxTraceDir(), FrxPid());
  }
  const char* ctlPath = ctlBuf;
  FILE* cf = fopen(ctlPath, "rb");
  if (!cf) {
    return;  // 无控制文件：不干预（env 启动的 trace 不受影响）
  }
  char buf[1024];
  size_t n = fread(buf, 1, sizeof(buf) - 1, cf);
  fclose(cf);
  buf[n] = '\0';
  bool want = (n > 0 && buf[0] == '1');
  // 自动过期：ctl 是 "1" 但 mtime 超过 300s 没刷新 → 视为关闭。防 Agent 开了 trace 忘了关、
  // 或上次会话遗留的 "1" 跨重启把执行拖垮。JS 侧 start/query 会刷新 ctl mtime 保活。
  if (want) {
    struct stat _ctlst;
    if (stat(ctlPath, &_ctlst) == 0 && (time(nullptr) - _ctlst.st_mtime) > 300) {
      want = false;
    }
  }
  if (want) {
    std::lock_guard<std::mutex> lock(gWriteMutex);
    // 每次轮询(只要 want=1)都刷新 filter：支持已 enabled 后再 start 换 filter，
    // 也修掉"早先用空 filter 启用过 → 之后带 filter 的 start 不生效 → 全量 trace"的坑。
    static std::string ctlFilter;
    std::string newFilter;
    char* nl = strchr(buf, '\n');
    if (nl && nl[1]) {
      newFilter.assign(nl + 1);
      while (!newFilter.empty()) {
        char c = newFilter.back();
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') {
          newFilter.pop_back();
        } else {
          break;
        }
      }
    }
    if (newFilter != ctlFilter) {
      ctlFilter = newFilter;
      gScriptFilter = ctlFilter.empty() ? nullptr : ctlFilter.c_str();
      gFilterVersion.fetch_add(1, std::memory_order_relaxed);  // 让各线程 filter 缓存失效
      gLimitReached = false;  // 换 filter = 新追踪意图 → 解除上限锁
    }
    // !gLimitReached 关键：已达上限而停的 trace，轮询不得复活（否则清零计数→无限增长）。
    if (!gTraceEnabled && !gLimitReached) {
      if (OpenOutputFileIfNeeded()) {
        gRecordCount.store(0, std::memory_order_relaxed);
        gTraceEnabled = true;
        PinInterpreterTier();  // 钉死解释器层，热 dispatcher 才不会逃出 hook
        fprintf(stderr, "[jsvmp-trace-B] runtime ENABLED via %s (filter=%s)\n", ctlPath,
                gScriptFilter ? gScriptFilter : "(all)");
      }
    }
  } else if (!want) {
    // 显式停止：无论当前是 enabled 还是"已达上限而停"，都解除上限锁，让下次 start 重新计数。
    gLimitReached = false;
    if (gTraceEnabled) {
      gTraceEnabled = false;
      RestoreJitTiers();  // 恢复 JIT，浏览器恢复正常速度
      std::lock_guard<std::mutex> lock(gWriteMutex);
      if (gOutFile) {
        fflush(gOutFile);
      }
      fprintf(stderr, "[jsvmp-trace-B] runtime DISABLED via %s\n", ctlPath);
    }
  }

  // ── 一次性"清空"请求：丢弃页面加载累积的噪声，但保持 trace 开启 + 解释器钉死 ──
  // 工作流：load→start→(加载噪声堆积)→clear→触发目标(签名/请求)→query。这样 query 读到的
  // 就是"触发那一段"，也不会被加载噪声占满 100 万条上限。通用，不含任何站点信息。
  // 请求文件按 pid 区分(<base>.<pid>)：只清当前标签所在内容进程，避免后台进程抢先消费+删除
  // 共享文件、导致前台进程没清成的竞态。消费即删 → 一次性，不会反复把刚抓的也清掉。
  {
    const char* clrEnv = getenv("MOZ_JSVMP_TRACE_CLEAR");
    char clrBaseBuf[1024];
    if (!(clrEnv && clrEnv[0])) {
      snprintf(clrBaseBuf, sizeof(clrBaseBuf), "%s/firefox-reverse-jsvmp.clear", FrxTraceDir());
    }
    const char* clrBase = (clrEnv && clrEnv[0]) ? clrEnv : clrBaseBuf;
    char clrPath[1088];
    snprintf(clrPath, sizeof(clrPath), "%s.%d", clrBase, FrxPid());
    FILE* clf = fopen(clrPath, "rb");
    if (clf) {
      fclose(clf);
      remove(clrPath);
      std::lock_guard<std::mutex> lock(gWriteMutex);
      if (gOutFile) {
        fflush(gOutFile);
        if (ftruncate(fileno(gOutFile), 0) == 0) {
          rewind(gOutFile);
        }
      }
      gRecordCount.store(0, std::memory_order_relaxed);
      gLimitReached = false;
      // 若此前撞上限被停、而控制文件仍要求开启 → 顺势恢复采集（保持解释器钉死）
      if (want && !gTraceEnabled) {
        gTraceEnabled = true;
        PinInterpreterTier();
      }
      if (gOutFile) {
        fprintf(gOutFile, "{\"_meta\":{\"cleared\":1,\"pid\":%d,\"ts\":%llu}}\n",
                FrxPid(), (unsigned long long)NowNanos());
        fflush(gOutFile);
      }
      fprintf(stderr, "[jsvmp-trace-B] trace buffer CLEARED via %s (count reset, %s)\n",
              clrPath, gTraceEnabled ? "still enabled" : "disabled");
    }
  }

  // 运行期 dump 配置（actions：locals/env/vpc/ret/args）——独立消费各自的 per-pid 文件，
  // 与上面的开关/filter/clear 互不影响。让 jsvmp_trace 的 dump 动作运行期真正生效。
  MaybeApplyDumpConfig();
}

}  // anonymous namespace

void EnsureInit() {
  // 运行期开关：每次进解释器都查一次控制文件（摊销），即使 trace 当前关闭也能被重新打开/关闭。
  MaybePollControlFile();

  bool expected = false;
  if (!gInitDone.compare_exchange_strong(expected, true)) {
    return;  // already initialized in another thread
  }

  const char* enable = getenv("MOZ_JSVMP_TRACE");
  if (!enable || enable[0] != '1') {
    return;  // disabled
  }

  const char* basePath = getenv("MOZ_JSVMP_TRACE_FILE");
  char baseBuf[1024];
  if (!basePath || !basePath[0]) {
    snprintf(baseBuf, sizeof(baseBuf), "%s/firefox-reverse-jsvmp-b.ndjson", FrxTraceDir());
    basePath = baseBuf;
  }

  char fullPath[1024];
  snprintf(fullPath, sizeof(fullPath), "%s.%d", basePath, FrxPid());

  gOutFile = fopen(fullPath, "w");
  if (!gOutFile) {
    fprintf(stderr, "[jsvmp-trace-B] failed to open %s: %s\n",
            fullPath, strerror(errno));
    return;
  }
  // line-buffered，方便 tail -f
  setvbuf(gOutFile, nullptr, _IOLBF, 0);

  gScriptFilter = getenv("MOZ_JSVMP_TRACE_SCRIPT");
  if (gScriptFilter && !gScriptFilter[0]) gScriptFilter = nullptr;

  const char* limitStr = getenv("MOZ_JSVMP_TRACE_LIMIT");
  if (limitStr && limitStr[0]) {
    uint64_t v = strtoull(limitStr, nullptr, 10);
    if (v > 0) gMaxRecords = v;
  }

  // dump_args 配置
  const char* dumpArgs = getenv("MOZ_JSVMP_DUMP_ARGS");
  if (dumpArgs && dumpArgs[0] == '1') {
    gDumpArgsEnabled = true;
    const char* col = getenv("MOZ_JSVMP_DUMP_ARGS_COL");
    if (col && col[0]) gDumpArgsCol = (uint32_t)strtoul(col, nullptr, 10);
    const char* lim = getenv("MOZ_JSVMP_DUMP_ARGS_LIMIT");
    if (lim && lim[0]) {
      uint64_t v = strtoull(lim, nullptr, 10);
      if (v > 0) gDumpArgsLimit = v;
    }
  }

  // dump_locals 配置 (Phase B.4)
  const char* dumpLocals = getenv("MOZ_JSVMP_DUMP_LOCALS");
  if (dumpLocals && dumpLocals[0] == '1') {
    gDumpLocalsEnabled = true;
    const char* col = getenv("MOZ_JSVMP_DUMP_LOCALS_COL");
    if (col && col[0]) gDumpLocalsCol = (uint32_t)strtoul(col, nullptr, 10);
    const char* pcv = getenv("MOZ_JSVMP_DUMP_LOCALS_PC");
    if (pcv && pcv[0]) gDumpLocalsPc = (uint32_t)strtoul(pcv, nullptr, 10);
    const char* lim = getenv("MOZ_JSVMP_DUMP_LOCALS_LIMIT");
    if (lim && lim[0]) {
      uint64_t v = strtoull(lim, nullptr, 10);
      if (v > 0) gDumpLocalsLimit = v;
    }
    const char* skip = getenv("MOZ_JSVMP_DUMP_LOCALS_SKIP");
    if (skip && skip[0]) gDumpLocalsSkip = strtoull(skip, nullptr, 10);
    const char* env = getenv("MOZ_JSVMP_DUMP_ENV");
    if (env && env[0] == '1') gDumpEnvEnabled = true;
    const char* depth = getenv("MOZ_JSVMP_DUMP_DEPTH");
    if (depth && depth[0]) {
      int d = (int)strtol(depth, nullptr, 10);
      if (d >= 0 && d <= 5) gDumpDepth = d;
    }
    const char* maxarr = getenv("MOZ_JSVMP_DUMP_MAXARR");
    if (maxarr && maxarr[0]) {
      uint32_t m = (uint32_t)strtoul(maxarr, nullptr, 10);
      if (m > 0 && m <= 1000000) gDumpMaxArr = m;
    }
  }

  // vpc_trace 配置 (Phase B.5)
  const char* vpc = getenv("MOZ_JSVMP_VPC_TRACE");
  if (vpc && vpc[0] == '1') {
    gVpcEnabled = true;
    const char* col = getenv("MOZ_JSVMP_VPC_COL");
    if (col && col[0]) gVpcCol = (uint32_t)strtoul(col, nullptr, 10);
    const char* pcv = getenv("MOZ_JSVMP_VPC_PC");
    if (pcv && pcv[0]) gVpcPc = (uint32_t)strtoul(pcv, nullptr, 10);
    const char* lim = getenv("MOZ_JSVMP_VPC_LIMIT");
    if (lim && lim[0]) { uint64_t v = strtoull(lim, nullptr, 10); if (v > 0) gVpcLimit = v; }
  }

  // dump_ret 配置 (Phase B.6)
  const char* dret = getenv("MOZ_JSVMP_DUMP_RET");
  if (dret && dret[0] == '1') {
    gDumpRetEnabled = true;
    const char* col = getenv("MOZ_JSVMP_DUMP_RET_COL");
    if (col && col[0]) gDumpRetCol = (uint32_t)strtoul(col, nullptr, 10);
    const char* lim = getenv("MOZ_JSVMP_DUMP_RET_LIMIT");
    if (lim && lim[0]) { uint64_t v = strtoull(lim, nullptr, 10); if (v > 0) gDumpRetLimit = v; }
    const char* skip = getenv("MOZ_JSVMP_DUMP_RET_SKIP");
    if (skip && skip[0]) gDumpRetSkip = strtoull(skip, nullptr, 10);
  }

  // meta 行
  fprintf(gOutFile,
          "{\"_meta\":{\"version\":\"phase-b.0\",\"pid\":%d,"
          "\"started_ns\":%llu,\"filter\":\"%s\",\"limit\":%llu}}\n",
          FrxPid(),
          (unsigned long long)NowNanos(),
          gScriptFilter ? gScriptFilter : "",
          (unsigned long long)gMaxRecords);
  fflush(gOutFile);

  fprintf(stderr,
          "[jsvmp-trace-B] enabled\n"
          "  output: %s\n"
          "  filter: %s\n"
          "  limit:  %llu\n"
          "  pid:    %d\n"
          "  dump_args: %s (col=%u, limit=%llu)\n"
          "  dump_locals: %s (col=%u, pc=%u, env=%s, depth=%d, limit=%llu)\n",
          fullPath,
          gScriptFilter ? gScriptFilter : "(none, all scripts)",
          (unsigned long long)gMaxRecords,
          FrxPid(),
          gDumpArgsEnabled ? "ON" : "off",
          gDumpArgsCol,
          (unsigned long long)gDumpArgsLimit,
          gDumpLocalsEnabled ? "ON" : "off",
          gDumpLocalsCol, gDumpLocalsPc,
          gDumpEnvEnabled ? "ON" : "off",
          gDumpDepth,
          (unsigned long long)gDumpLocalsLimit);

  // 最后启用 hot path
  gTraceEnabled = true;
  PinInterpreterTier();  // env 启动期 trace 也钉死解释器层
}

// 序列化 JS::Value 到 JSON（简化版：string + 数字 + bool + null/undefined）
static void SerializeValue(JSContext* cx, JS::HandleValue v, FILE* f) {
  if (v.isString()) {
    JSString* s = v.toString();
    size_t len = JS::GetStringLength(s);
    // 限长，超长 string 截断（hex bytecode 也才几十 KB）
    if (len > 131072) {
      fputs("\"<string-too-long-", f);
      fprintf(f, "%zu>\"", len);
      return;
    }
    JS::UniqueChars utf8 = JS_EncodeStringToUTF8(cx, JS::RootedString(cx, s));
    if (utf8) {
      WriteJsonEscaped(f, utf8.get());
    } else {
      fputs("\"<encode-fail>\"", f);
    }
  } else if (v.isInt32()) {
    fprintf(f, "%d", v.toInt32());
  } else if (v.isDouble()) {
    double d = v.toDouble();
    if (std::isnan(d) || std::isinf(d)) {
      fputs("\"<nan-or-inf>\"", f);
    } else {
      fprintf(f, "%g", d);
    }
  } else if (v.isBoolean()) {
    fputs(v.toBoolean() ? "true" : "false", f);
  } else if (v.isNull()) {
    fputs("null", f);
  } else if (v.isUndefined()) {
    fputs("\"<undefined>\"", f);
  } else if (v.isObject()) {
    fputs("\"<object>\"", f);
  } else {
    fputs("\"<?>\"", f);
  }
}

// 深度序列化：对象展开 own enumerable 属性、数组展开元素（depth 控制层数）。
// 用于 dump_locals/env —— 把 JSVMP 常量对象(如 xor key {q:[...],p:[...]})完整 dump 出来。
static void SerializeValueDeep(JSContext* cx, JS::HandleValue v, FILE* f, int depth) {
  if (!v.isObject() || depth <= 0) {
    if (v.isObject()) { fputs("\"<object>\"", f); return; }
    SerializeValue(cx, v, f);
    return;
  }
  JS::RootedObject obj(cx, &v.toObject());

  // 函数对象：只标注，别展开
  if (JS::IsCallable(obj)) { fputs("\"<function>\"", f); return; }

  // 数组
  bool isArray = false;
  if (JS::IsArrayObject(cx, obj, &isArray) && isArray) {
    uint32_t len = 0;
    JS::GetArrayLength(cx, obj, &len);
    uint32_t cap = len > gDumpMaxArr ? gDumpMaxArr : len;
    fputc('[', f);
    for (uint32_t i = 0; i < cap; i++) {
      if (i) fputc(',', f);
      JS::RootedValue ev(cx);
      if (JS_GetElement(cx, obj, i, &ev)) SerializeValueDeep(cx, ev, f, depth - 1);
      else fputs("null", f);
    }
    if (len > cap) fprintf(f, ",\"<+%u more>\"", len - cap);
    fputc(']', f);
    return;
  }

  // 普通对象：own keys（限 32 个）。用 js::GetPropertyKeys（RootedIdVector 的 &ids
  // 正好是 MutableHandleIdVector；JS_Enumerate 要的 MutableHandle<IdVector> 不兼容）
  JS::RootedIdVector ids(cx);
  if (!js::GetPropertyKeys(cx, obj, JSITER_OWNONLY, &ids)) { fputs("\"<enum-fail>\"", f); return; }
  fputc('{', f);
  size_t cap = ids.length() > 32 ? 32 : ids.length();
  bool first = true;
  for (size_t i = 0; i < cap; i++) {
    JS::RootedId id(cx, ids[i]);
    // key：仅 string / int 两类
    char keyBuf[64];
    if (id.isString()) {
      JS::UniqueChars kc = JS_EncodeStringToUTF8(cx, JS::RootedString(cx, id.toString()));
      if (!kc) continue;
      if (!first) fputc(',', f); first = false;
      WriteJsonEscaped(f, kc.get());
    } else if (id.isInt()) {
      snprintf(keyBuf, sizeof(keyBuf), "%d", id.toInt());
      if (!first) fputc(',', f); first = false;
      WriteJsonEscaped(f, keyBuf);
    } else {
      continue;  // symbol 等跳过
    }
    fputc(':', f);
    JS::RootedValue pv(cx);
    if (JS_GetPropertyById(cx, obj, id, &pv)) SerializeValueDeep(cx, pv, f, depth - 1);
    else fputs("\"<get-fail>\"", f);
  }
  if (ids.length() > cap) fprintf(f, "%s\"<+%zu more>\":1", first ? "" : ",", ids.length() - cap);
  fputc('}', f);
}

// 在 function entry 触发：walk frame stack 找 this script 对应的 frame，dump args
static void DumpFunctionArgs(JSContext* cx, JSScript* script) {
  uint64_t cnt = gDumpArgsCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt >= gDumpArgsLimit) return;

  for (js::FrameIter iter(cx); !iter.done(); ++iter) {
    if (!iter.hasScript() || iter.script() != script) continue;

    js::AbstractFramePtr frame = iter.abstractFramePtr();
    if (!frame) break;

    unsigned numActualArgs = frame.numActualArgs();
    if (numActualArgs > 32) numActualArgs = 32;  // 安全限

    std::lock_guard<std::mutex> lk(gWriteMutex);
    fprintf(gOutFile,
            "{\"_args\":{\"sid\":\"%p\",\"n\":%u,\"args\":[",
            (void*)script, numActualArgs);

    for (unsigned i = 0; i < numActualArgs; i++) {
      if (i > 0) fputs(",", gOutFile);
      JS::RootedValue v(cx, frame.unaliasedActual(i));
      SerializeValue(cx, v, gOutFile);
    }
    fputs("]}}\n", gOutFile);
    fflush(gOutFile);
    break;
  }
}

// Phase B.4：在指定 (col, pc) dump 帧局部变量 + 实参 + （可选）闭包/环境链。
// 通用：拿运行时常量（xor key / 常量池 / 闭包对象），静态分析拿不到的值。
static void DumpLocals(JSContext* cx, JSScript* script, uint32_t pc_offset) {
  uint64_t cnt = gDumpLocalsCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt < gDumpLocalsSkip) return;                       // 跳过前 N 次(拿执行末尾=输出已成型)
  if (cnt - gDumpLocalsSkip >= gDumpLocalsLimit) return;

  for (js::FrameIter iter(cx); !iter.done(); ++iter) {
    if (!iter.hasScript() || iter.script() != script) continue;

    js::AbstractFramePtr frame = iter.abstractFramePtr();
    if (!frame) break;

    unsigned nlocals = script->nfixed();   // fixed-slot 局部变量数
    if (nlocals > 64) nlocals = 64;
    unsigned nargs = frame.numActualArgs();
    if (nargs > 32) nargs = 32;

    std::lock_guard<std::mutex> lk(gWriteMutex);
    fprintf(gOutFile, "{\"_locals\":{\"sid\":\"%p\",\"pc\":%u,\"nloc\":%u,\"narg\":%u",
            (void*)script, pc_offset, nlocals, nargs);

    // 局部变量
    fputs(",\"locals\":[", gOutFile);
    for (unsigned i = 0; i < nlocals; i++) {
      if (i > 0) fputc(',', gOutFile);
      JS::RootedValue v(cx, frame.unaliasedLocal(i));
      SerializeValueDeep(cx, v, gOutFile, gDumpDepth);
    }
    fputs("]", gOutFile);

    // 实参
    fputs(",\"args\":[", gOutFile);
    for (unsigned i = 0; i < nargs; i++) {
      if (i > 0) fputc(',', gOutFile);
      JS::RootedValue v(cx, frame.unaliasedActual(i));
      SerializeValueDeep(cx, v, gOutFile, gDumpDepth);
    }
    fputs("]", gOutFile);

    // 闭包/环境链：从帧环境链往外 walk，dump 每层可见绑定（拿外层作用域常量）
    if (gDumpEnvEnabled) {
      fputs(",\"env\":[", gOutFile);
      JS::RootedObject env(cx, frame.environmentChain());
      int depth = 0;
      bool firstEnv = true;
      while (env && depth < 8) {
        if (!firstEnv) fputc(',', gOutFile);
        firstEnv = false;
        JS::RootedValue envVal(cx, JS::ObjectValue(*env));
        SerializeValueDeep(cx, envVal, gOutFile, gDumpDepth);
        if (env->is<js::EnvironmentObject>()) {
          env = &env->as<js::EnvironmentObject>().enclosingEnvironment();
        } else {
          break;  // 到 global / 非环境对象，停
        }
        depth++;
      }
      fputs("]", gOutFile);
    }

    fputs("}}\n", gOutFile);
    fflush(gOutFile);
    break;
  }
}

// Phase B.5：轻量「虚拟寄存器快照」——每命中(col,pc)记一行帧数值 locals+args。
// 只读数值(int/double)，不深序列化/不 walk env，足够快撑住百万次命中。
// 通用：哪个槽是虚拟 pc 由离线分析(看哪个序列像字节码下标)决定，C++ 不预设。
static void EmitVpc(JSContext* cx, JSScript* script) {
  uint64_t cnt = gVpcCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt >= gVpcLimit) {
    if (cnt == gVpcLimit) { std::lock_guard<std::mutex> lk(gWriteMutex);
      fputs("{\"_vpc_end\":1}\n", gOutFile); fflush(gOutFile); }
    return;
  }
  for (js::FrameIter iter(cx); !iter.done(); ++iter) {
    if (!iter.hasScript() || iter.script() != script) continue;
    js::AbstractFramePtr frame = iter.abstractFramePtr();
    if (!frame) break;
    unsigned nloc = script->nfixed(); if (nloc > 32) nloc = 32;
    unsigned narg = frame.numActualArgs(); if (narg > 16) narg = 16;
    std::lock_guard<std::mutex> lk(gWriteMutex);
    fputs("{\"_vpc\":{\"l\":[", gOutFile);
    for (unsigned i = 0; i < nloc; i++) {
      if (i) fputc(',', gOutFile);
      JS::Value v = frame.unaliasedLocal(i);
      if (v.isInt32()) fprintf(gOutFile, "%d", v.toInt32());
      else if (v.isDouble()) fprintf(gOutFile, "%g", v.toDouble());
      else fputs("null", gOutFile);
    }
    fputs("],\"a\":[", gOutFile);
    for (unsigned i = 0; i < narg; i++) {
      if (i) fputc(',', gOutFile);
      JS::Value v = frame.unaliasedActual(i);
      if (v.isInt32()) fprintf(gOutFile, "%d", v.toInt32());
      else if (v.isDouble()) fprintf(gOutFile, "%g", v.toDouble());
      else fputs("null", gOutFile);
    }
    fputs("]}}\n", gOutFile);  // 行缓冲自动 flush
    break;
  }
}

// Phase B.6：在 JS 函数返回(RetRval：此时 rval 已被 SetRval 设好)dump 返回值。
// 通用：递归 VM 最外层返回值 = 最终产物。SKIP 跳到最后一次返回取最外层。
static void DumpRet(JSContext* cx, JSScript* script, uint32_t pc_offset,
                    const void* spTop, uint32_t col, unsigned line) {
  uint64_t cnt = gDumpRetCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt < gDumpRetSkip) return;
  if (cnt - gDumpRetSkip >= gDumpRetLimit) return;
  // RETURN 处操作数栈顶 spTop[-1] = 即将返回的值（frame.returnValue() 此刻还没设，会是 undefined）
  if (!spTop) return;
  const JS::Value* sp = reinterpret_cast<const JS::Value*>(spTop);
  JS::RootedValue rv(cx, sp[-1]);
  std::lock_guard<std::mutex> lk(gWriteMutex);
  fprintf(gOutFile, "{\"_ret\":{\"sid\":\"%p\",\"pc\":%u,\"ln\":%u,\"col\":%u,\"n\":%llu,\"val\":",
          (void*)script, pc_offset, line, col, (unsigned long long)cnt);
  SerializeValueDeep(cx, rv, gOutFile, gDumpDepth);
  fputs("}}\n", gOutFile);
  fflush(gOutFile);
}

void RecordOpcodeImpl(JSContext* cx, JSScript* script, uint8_t* pc,
                      uint8_t opcode, const void* spTop) {
  // 安全检查
  if (!script) return;
  if (!gOutFile) return;

  // filter check first (with thread_local cache to avoid strstr-per-op)
  // 关键: count 必须在 filter 之后涨，否则 unfiltered op 会把 limit 打满
  if (gScriptFilter) {
    if (!tlsFilterCache) {
      tlsFilterCache = new std::unordered_map<JSScript*, uint8_t>();
    }
    // filter 变了(gFilterVersion 变化) → 本线程旧缓存作废，重算
    uint32_t ver = gFilterVersion.load(std::memory_order_relaxed);
    if (tlsFilterVersion != ver) {
      tlsFilterCache->clear();
      tlsFilterVersion = ver;
    }
    uint8_t cached = (*tlsFilterCache)[script];
    if (cached == 0) {
      const char* fn = script->filename();
      bool matches = fn && strstr(fn, gScriptFilter);
      cached = matches ? 1 : 2;
      (*tlsFilterCache)[script] = cached;
    }
    if (cached == 2) return;  // filter no-match
  }

  // 拿 filename（已通过 filter；或无 filter 全 trace）
  const char* fn = script->filename();
  if (!fn) return;

  // 上限：只对 filter 命中的 op 计数
  uint64_t cnt = gRecordCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt >= gMaxRecords) {
    if (cnt == gMaxRecords) {
      // 第一次超限：写一行警告 + 禁用 hot path
      std::lock_guard<std::mutex> lk(gWriteMutex);
      fprintf(gOutFile,
              "{\"_warn\":\"trace limit reached, stopping\",\"count\":%llu}\n",
              (unsigned long long)cnt);
      fflush(gOutFile);
      gTraceEnabled = false;
      gLimitReached = true;  // 锁住：轮询不得复活（否则清零计数→cap→复活→无限增长 4GB）
      RestoreJitTiers();     // 撞上限也恢复 JIT
    }
    return;
  }

  // thread-local: 首次见到该 script 时，写一条 meta 包含 filename
  if (!tlsSeenScripts) {
    tlsSeenScripts = new std::unordered_set<JSScript*>();
  }
  bool firstSeen = tlsSeenScripts->insert(script).second;

  uint32_t pc_offset = uint32_t(pc - script->code());

  // opname + line/col （都是 SpiderMonkey 公共 API）
  const char* opName = js::CodeName(JSOp(opcode));
  JS::LimitedColumnNumberOneOrigin column;
  unsigned line = js::PCToLineNumber(script, pc, &column);

  // 携带**内联整数立即数**的 opcode：额外记录其操作数值(imm)。通用：补全反汇编里
  // Int8/Int32 等的常量、帮离线据值反推那些 split 没识别出的 opcode 算术语义(掩码/移位/模数等)。
  // 立即数就在 pc+1 处(GET_INT8/UINT16/UINT24/INT32，与解释器 CASE 同源)，非站点信息。
  // String/Double/Object 等是按脚本常量表**索引**引用(需查表)，此处从简不做。
  bool hasImm = false;
  long long immVal = 0;
  switch (JSOp(opcode)) {
    case JSOp::Int8:   immVal = (long long)GET_INT8(pc);   hasImm = true; break;
    case JSOp::Uint16: immVal = (long long)GET_UINT16(pc); hasImm = true; break;
    case JSOp::Uint24: immVal = (long long)GET_UINT24(pc); hasImm = true; break;
    case JSOp::Int32:  immVal = (long long)GET_INT32(pc);  hasImm = true; break;
    default: break;
  }

  {
    std::lock_guard<std::mutex> lk(gWriteMutex);

    if (firstSeen) {
      fputs("{\"_script\":{\"sid\":\"", gOutFile);
      fprintf(gOutFile, "%p", (void*)script);
      fputs("\",\"file\":", gOutFile);
      WriteJsonEscaped(gOutFile, fn);
      fputs("}}\n", gOutFile);
    }

    // 主 trace 行：sid + pc + op + opname + line + col (+imm，若该 op 带内联整数立即数)
    fputs("{\"sid\":\"", gOutFile);
    fprintf(gOutFile, "%p", (void*)script);
    if (hasImm) {
      fprintf(gOutFile,
              "\",\"pc\":%u,\"op\":%u,\"n\":\"%s\",\"ln\":%u,\"col\":%u,\"imm\":%lld}\n",
              pc_offset, (unsigned)opcode, opName ? opName : "?",
              line, column.oneOriginValue(), immVal);
    } else {
      fprintf(gOutFile,
              "\",\"pc\":%u,\"op\":%u,\"n\":\"%s\",\"ln\":%u,\"col\":%u}\n",
              pc_offset, (unsigned)opcode, opName ? opName : "?",
              line, column.oneOriginValue());
    }
  }

  // dump function args 在 function entry (pc=0) 时触发
  // gDumpArgsCol = 0 表示任何 function 入口都 dump，否则只匹配指定 col
  if (MOZ_UNLIKELY(gDumpArgsEnabled) && pc_offset == 0) {
    uint32_t scriptCol = column.oneOriginValue();
    if (gDumpArgsCol == 0 || scriptCol == gDumpArgsCol) {
      DumpFunctionArgs(cx, script);
    }
  }

  // dump locals/env (Phase B.4)：在指定 (col, pc) 触发。
  // pc 默认 0(入口)；也可设 dispatcher 里某个 pc（如 xor key 已加载入作用域之后）。
  if (MOZ_UNLIKELY(gDumpLocalsEnabled) && pc_offset == gDumpLocalsPc) {
    uint32_t scriptCol = column.oneOriginValue();
    if (gDumpLocalsCol == 0 || scriptCol == gDumpLocalsCol) {
      DumpLocals(cx, script, pc_offset);
    }
  }

  // vpc_trace (Phase B.5)：在派发循环头 (col, pc) 每次命中轻量快照寄存器。
  if (MOZ_UNLIKELY(gVpcEnabled) && pc_offset == gVpcPc) {
    uint32_t scriptCol = column.oneOriginValue();
    if (gVpcCol == 0 || scriptCol == gVpcCol) {
      EmitVpc(cx, script);
    }
  }

  // dump_ret (Phase B.6)：JS 函数返回(RetRval/Return)处 dump 返回值。
  if (MOZ_UNLIKELY(gDumpRetEnabled) && opName &&
      (!strcmp(opName, "RetRval") || !strcmp(opName, "Return"))) {
    uint32_t scriptCol = column.oneOriginValue();
    if (gDumpRetCol == 0 || scriptCol == gDumpRetCol) {
      DumpRet(cx, script, pc_offset, spTop, scriptCol, line);
    }
  }
}

}  // namespace jsvmp
}  // namespace mozilla
