/* WebApiTraceCore.cpp — 通用 Web-API 调用追踪实现（见 .h）。
 * 与 js/src/vm/JsvmpTraceCore.cpp 同构：运行期控制文件 + per-pid NDJSON + filter + 上限锁。
 * 由 codegen 注入的 AutoTraceMethod/AutoTraceGetter 在方法/getter 生成体里调用 RecordNamed。
 * 通用，无任何站点信息。
 */
#include "WebApiTraceCore.h"

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
// 跨平台 trace 目录 + pid：mac/Linux 不变（/tmp、getpid）；Windows 用系统 TEMP（与 JS Services.env("TEMP") 同源）。
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

#include "jsapi.h"                  // JS_ClearPendingException
#include "js/Array.h"               // JS::IsArrayObject, JS::GetArrayLength
#include "js/CallAndConstruct.h"    // JS::IsCallable
#include "js/CharacterEncoding.h"   // JS_EncodeStringToUTF8
#include "js/Object.h"              // JS::GetClass
#include "js/PropertyAndElement.h"  // JS_GetElement
#include "js/String.h"              // JS::GetStringLength
#include "js/Value.h"
#include "js/experimental/TypedData.h"  // JS_IsTypedArrayObject, JS_GetTypedArrayLength

namespace mozilla {
namespace webapitrace {

bool gEnabled = false;

namespace {

std::mutex gWriteMutex;
FILE* gOutFile = nullptr;
std::string gFilterStr;
const char* gFilter = nullptr;  // nullptr = 不过滤
uint64_t gMaxRecords = 2000000;
std::atomic<uint64_t> gRecordCount{0};
bool gLimitReached = false;

uint64_t NowNanos() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000000000ULL + uint64_t(ts.tv_nsec);
}

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

// 只读、不触发用户 getter（防签名计算被扰动/重入）：基本类型+字符串直接序列化；
// TypedArray 读元素(原生，无用户 getter)；普通数组/对象只打标签。
void SerializeVal(JSContext* cx, JS::Handle<JS::Value> v, FILE* f) {
  if (v.isString()) {
    JSString* s = v.toString();
    size_t len = JS::GetStringLength(s);
    if (len > 16384) {
      fprintf(f, "\"<string-len-%zu>\"", len);
      return;
    }
    JS::Rooted<JSString*> rs(cx, s);
    JS::UniqueChars utf8 = JS_EncodeStringToUTF8(cx, rs);
    if (utf8) {
      WriteJsonEscaped(f, utf8.get());
    } else {
      JS_ClearPendingException(cx);
      fputs("\"<enc-fail>\"", f);
    }
  } else if (v.isInt32()) {
    fprintf(f, "%d", v.toInt32());
  } else if (v.isDouble()) {
    double d = v.toDouble();
    if (std::isnan(d) || std::isinf(d)) {
      fputs("\"<nan-or-inf>\"", f);
    } else {
      fprintf(f, "%.17g", d);
    }
  } else if (v.isBoolean()) {
    fputs(v.toBoolean() ? "true" : "false", f);
  } else if (v.isNull()) {
    fputs("null", f);
  } else if (v.isUndefined()) {
    fputs("\"<undefined>\"", f);
  } else if (v.isObject()) {
    JS::Rooted<JSObject*> obj(cx, &v.toObject());
    if (JS_IsTypedArrayObject(obj)) {
      size_t len = JS_GetTypedArrayLength(obj);
      size_t cap = len > 1024 ? 1024 : len;
      fputc('[', f);
      for (size_t i = 0; i < cap; i++) {
        if (i) fputc(',', f);
        JS::Rooted<JS::Value> ev(cx);
        if (JS_GetElement(cx, obj, (uint32_t)i, &ev) && ev.isNumber()) {
          if (ev.isInt32()) fprintf(f, "%d", ev.toInt32());
          else fprintf(f, "%.17g", ev.toDouble());
        } else {
          JS_ClearPendingException(cx);
          fputs("null", f);
        }
      }
      if (len > cap) fprintf(f, ",\"<+%zu>\"", len - cap);
      fputc(']', f);
      return;
    }
    bool isArr = false;
    if (JS::IsArrayObject(cx, obj, &isArr) && isArr) {
      uint32_t alen = 0;
      JS::GetArrayLength(cx, obj, &alen);
      fprintf(f, "\"<array len=%u>\"", alen);
      return;
    }
    JS_ClearPendingException(cx);
    if (JS::IsCallable(obj)) {
      fputs("\"<function>\"", f);
      return;
    }
    const JSClass* clasp = JS::GetClass(obj);
    fprintf(f, "\"<object %s>\"", clasp && clasp->name ? clasp->name : "?");
  } else {
    fputs("\"<?>\"", f);
  }
}

bool OpenFileIfNeeded() {
  if (gOutFile) {
    return true;
  }
  const char* base = getenv("MOZ_WEBAPI_TRACE_FILE");
  char baseBuf[1024];
  if (!base || !base[0]) {
    snprintf(baseBuf, sizeof(baseBuf), "%s/firefox-reverse-webapi.ndjson", FrxTraceDir());
    base = baseBuf;
  }
  char full[1024];
  snprintf(full, sizeof(full), "%s.%d", base, FrxPid());
  gOutFile = fopen(full, "w");
  if (!gOutFile) {
    fprintf(stderr, "[webapi-trace] failed to open %s: %s\n", full, strerror(errno));
    return false;
  }
  setvbuf(gOutFile, nullptr, _IOLBF, 0);
  fprintf(gOutFile,
          "{\"_meta\":{\"webapi\":1,\"pid\":%d,\"started_ns\":%llu,\"filter\":\"%s\"}}\n",
          FrxPid(), (unsigned long long)NowNanos(), gFilter ? gFilter : "");
  fflush(gOutFile);
  return true;
}

}  // anonymous namespace

void MaybePoll() {
  static std::atomic<uint32_t> pollCounter{0};
  if ((pollCounter.fetch_add(1, std::memory_order_relaxed) & 0x3FF) != 0) {
    return;  // 每 1024 次才真读控制文件（热路径摊销）
  }
  const char* ctlEnv = getenv("MOZ_WEBAPI_TRACE_CTL");
  // per-PID ctl：每个内容进程各自的控制文件，多会话/多标签页互不干扰（同一个 base.pid）。
  // 后备仍是全局 base（兼容旧手动设置或单进程场景）。
  char ctlBuf[256];
  if (ctlEnv && ctlEnv[0]) {
    strncpy(ctlBuf, ctlEnv, sizeof(ctlBuf) - 1);
    ctlBuf[sizeof(ctlBuf) - 1] = '\0';
  } else {
    snprintf(ctlBuf, sizeof(ctlBuf), "%s/firefox-reverse-webapi.ctl.%d", FrxTraceDir(), FrxPid());
  }
  const char* ctlPath = ctlBuf;
  FILE* cf = fopen(ctlPath, "rb");
  if (!cf) {
    return;
  }
  char buf[1024];
  size_t n = fread(buf, 1, sizeof(buf) - 1, cf);
  fclose(cf);
  buf[n] = '\0';
  bool want = (n > 0 && buf[0] == '1');
  // 自动过期：ctl 是 "1" 但 mtime 超过 300s 没刷新 → 视为关闭。防 Agent 开了 trace 忘了关、
  // 或上次会话遗留的 "1" 跨重启把每个页面都 trace 到打不开。JS 侧 start/query 会刷新 ctl mtime 保活。
  if (want) {
    struct stat _ctlst;
    if (stat(ctlPath, &_ctlst) == 0 && (time(nullptr) - _ctlst.st_mtime) > 300) {
      want = false;
    }
  }
  std::lock_guard<std::mutex> lock(gWriteMutex);
  if (want) {
    std::string newFilter;
    char* nl = strchr(buf, '\n');
    if (nl && nl[1]) {
      newFilter.assign(nl + 1);
      while (!newFilter.empty()) {
        char c = newFilter.back();
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') newFilter.pop_back();
        else break;
      }
    }
    if (newFilter != gFilterStr) {
      gFilterStr = newFilter;
      gFilter = gFilterStr.empty() ? nullptr : gFilterStr.c_str();
      gLimitReached = false;
    }
    if (!gEnabled && !gLimitReached) {
      if (OpenFileIfNeeded()) {
        gRecordCount.store(0, std::memory_order_relaxed);
        gEnabled = true;
        fprintf(stderr, "[webapi-trace] ENABLED via %s (filter=%s)\n", ctlPath,
                gFilter ? gFilter : "(all)");
      }
    }
  } else {
    gLimitReached = false;
    if (gEnabled) {
      gEnabled = false;
      if (gOutFile) fflush(gOutFile);
      fprintf(stderr, "[webapi-trace] DISABLED via %s\n", ctlPath);
    }
  }
}

void RecordNamed(JSContext* cx, const char* name, int kind, const JS::Value* argv,
                 unsigned argc, JS::Handle<JS::Value> rval) {
  if (!gOutFile || !name) {
    return;
  }
  // filter：name 是编译期字面量 "Iface.member"，strstr 极廉价；命中才记。
  if (gFilter && !strstr(name, gFilter)) {
    return;
  }
  uint64_t cnt = gRecordCount.fetch_add(1, std::memory_order_relaxed);
  if (cnt >= gMaxRecords) {
    if (cnt == gMaxRecords) {
      std::lock_guard<std::mutex> lk(gWriteMutex);
      fprintf(gOutFile, "{\"_warn\":\"webapi trace limit reached\",\"count\":%llu}\n",
              (unsigned long long)cnt);
      fflush(gOutFile);
      gEnabled = false;
      gLimitReached = true;
    }
    return;
  }
  // 拆 "Iface.member" → iface / member（标识符无点，按首个 '.' 分）
  const char* dot = strchr(name, '.');
  char iface[128];
  size_t il = dot ? (size_t)(dot - name) : strlen(name);
  if (il > sizeof(iface) - 1) il = sizeof(iface) - 1;
  memcpy(iface, name, il);
  iface[il] = '\0';
  const char* member = dot ? dot + 1 : "";

  std::lock_guard<std::mutex> lk(gWriteMutex);
  fputs("{\"if\":", gOutFile);
  WriteJsonEscaped(gOutFile, iface);
  fputs(",\"m\":", gOutFile);
  WriteJsonEscaped(gOutFile, member);
  // ts = 单调毫秒（用于"高级"档执行流程的时序/间隔分析）。
  fprintf(gOutFile, ",\"k\":\"%s\",\"ts\":%llu,\"a\":[", kind == 1 ? "get" : "method",
          (unsigned long long)(NowNanos() / 1000000ULL));
  unsigned an = argc > 16 ? 16 : argc;
  for (unsigned i = 0; i < an && argv; i++) {
    if (i) fputc(',', gOutFile);
    JS::Rooted<JS::Value> av(cx, argv[i]);
    SerializeVal(cx, av, gOutFile);
  }
  fputs("],\"r\":", gOutFile);
  SerializeVal(cx, rval, gOutFile);
  fputs("}\n", gOutFile);  // 行缓冲自动 flush
}

}  // namespace webapitrace
}  // namespace mozilla
