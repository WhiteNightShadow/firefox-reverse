/* Phase A.0 PoC: JSVMP trace via JS_AddInterruptCallback
 *
 * See JsvmpTraceHook.h for design notes.
 *
 * Environment variables:
 *   MOZ_JSVMP_TRACE=1                    总开关
 *   MOZ_JSVMP_TRACE_FILE=<path>          输出 NDJSON 路径（自动追加 .<pid>）
 *                                        默认 /tmp/firefox-reverse-jsvmp.ndjson
 *   MOZ_JSVMP_TRACE_SCRIPT=<substring>   只 trace filename 含此子串的 script
 *                                        默认无过滤（全部 trace）
 *   MOZ_JSVMP_TRACE_TICK_MS=<n>          手动 RequestInterruptCallback 周期
 *                                        默认不主动 request（依赖 mozilla 自身触发）
 */

#include "JsvmpTraceHook.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
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

#include "jsapi.h"               // JS::AutoFilename, JS::DescribeScriptedCaller
#include "js/ColumnNumber.h"     // JS::ColumnNumberOneOrigin
#include "js/Interrupt.h"        // JS_AddInterruptCallback

namespace mozilla {
namespace jsvmp {

namespace {

// 全局状态（per-process）
struct TraceState {
  bool initialized = false;
  bool enabled = false;
  FILE* file = nullptr;
  const char* scriptFilter = nullptr;  // substring filter, NULL=无过滤
  uint64_t hits = 0;     // callback 触发总次数
  uint64_t writes = 0;   // 实际写入文件的行数
};

static TraceState gState;

static uint64_t NowNanos() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static void InitOnce() {
  if (gState.initialized) return;
  gState.initialized = true;

  const char* enable = getenv("MOZ_JSVMP_TRACE");
  if (!enable || enable[0] != '1') {
    return;
  }

  const char* basePath = getenv("MOZ_JSVMP_TRACE_FILE");
  char baseBuf[1024];
  if (!basePath || !basePath[0]) {
    snprintf(baseBuf, sizeof(baseBuf), "%s/firefox-reverse-jsvmp.ndjson", FrxTraceDir());
    basePath = baseBuf;
  }

  // 文件名追加 pid 避免多进程冲突
  char fullPath[1024];
  snprintf(fullPath, sizeof(fullPath), "%s.%d", basePath, FrxPid());

  gState.file = fopen(fullPath, "w");
  if (!gState.file) {
    fprintf(stderr, "[jsvmp-trace] failed to open %s: %s\n",
            fullPath, strerror(errno));
    return;
  }

  // line-buffered 比 default fully-buffered 更适合追 tail -f
  setvbuf(gState.file, nullptr, _IOLBF, 0);

  gState.scriptFilter = getenv("MOZ_JSVMP_TRACE_SCRIPT");
  if (gState.scriptFilter && !gState.scriptFilter[0]) {
    gState.scriptFilter = nullptr;
  }

  gState.enabled = true;

  fprintf(stderr,
          "[jsvmp-trace] enabled\n"
          "  output: %s\n"
          "  filter: %s\n"
          "  pid:    %d\n",
          fullPath,
          gState.scriptFilter ? gState.scriptFilter : "(none, all scripts)",
          FrxPid());

  // 头部元信息
  fprintf(gState.file,
          "{\"_meta\":{\"version\":\"phase-a.0\",\"pid\":%d,"
          "\"started_ns\":%llu,\"filter\":\"%s\"}}\n",
          FrxPid(),
          (unsigned long long)NowNanos(),
          gState.scriptFilter ? gState.scriptFilter : "");
}

// JSON 字符串转义（只处理必要字符）
static void WriteJsonEscaped(FILE* f, const char* s) {
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

static bool TraceCallback(JSContext* cx) {
  InitOnce();
  if (!gState.enabled || !gState.file) {
    return true;
  }

  gState.hits++;

  // 拿当前 JS 脚本 filename + line + column
  // 签名: bool DescribeScriptedCaller(AutoFilename*, JSContext*, uint32_t*,
  //                                   ColumnNumberOneOrigin*)
  JS::AutoFilename filename;
  uint32_t line = 0;
  JS::ColumnNumberOneOrigin column;
  if (!JS::DescribeScriptedCaller(&filename, cx, &line, &column)) {
    return true;  // 不在 JS 栈
  }

  const char* fn = filename.get();
  if (!fn) {
    return true;
  }

  // URL 过滤（substring 匹配）
  if (gState.scriptFilter && !strstr(fn, gState.scriptFilter)) {
    return true;
  }

  // 写一行 NDJSON
  fputs("{\"ts\":", gState.file);
  fprintf(gState.file, "%llu", (unsigned long long)NowNanos());
  fputs(",\"file\":", gState.file);
  WriteJsonEscaped(gState.file, fn);
  fprintf(gState.file, ",\"ln\":%u,\"col\":%u}\n",
          line, column.oneOriginValue());

  gState.writes++;
  return true;
}

}  // anonymous namespace

void RegisterTraceCallback(JSContext* cx) {
  InitOnce();
  if (!gState.enabled) {
    return;
  }
  if (!JS_AddInterruptCallback(cx, TraceCallback)) {
    fprintf(stderr, "[jsvmp-trace] JS_AddInterruptCallback failed\n");
  } else {
    fprintf(stderr, "[jsvmp-trace] callback registered for cx=%p\n",
            (void*)cx);
  }
}

}  // namespace jsvmp
}  // namespace mozilla
