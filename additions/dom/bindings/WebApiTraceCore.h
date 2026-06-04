/* WebApiTraceCore.h — 引擎层「通用 Web-API 调用追踪」(RuyiTrace 模式)。
 *
 * 由 Codegen.py 在**每个 WebIDL 方法/属性读的生成体**顶部注入一个 RAII(AutoTraceMethod/
 * AutoTraceGetter)，接口名+成员名取**编译期字面量**(BindingUtils 的 JS_GetFunctionId 在运行期
 * 取不到匿名 native 的名字，故必须 codegen 注入)。RAII 析构在函数返回时(args.rval() 已设)触发，
 * 记录 interface.member(args)→return 到 per-pid NDJSON。**C++ 引擎层、JS 不可检测**。
 * 覆盖 generic(经 trampoline 调生成体)+ specialized(XHR 等直接 JSNative)。
 * 运行期开关 = /tmp/firefox-reverse-webapi.ctl(首字节 1/0 + 可选第二行 filter)。无站点信息。
 *
 * 本头被 BindingUtils.h #include → 所有生成的 binding 都能用 AutoTrace*。
 */
#ifndef mozilla_dom_WebApiTraceCore_h
#define mozilla_dom_WebApiTraceCore_h

#include "js/TypeDecls.h"
#include "js/Value.h"
#include "js/RootingAPI.h"
#include "js/experimental/JitInfo.h"  // JSJitMethodCallArgs / JSJitGetterCallArgs

namespace mozilla {
namespace webapitrace {

// 热路径门控：RAII 构造/析构只 check 这一个 bool（disabled 时近零成本）。
extern bool gEnabled;

// 摊销轮询控制文件（即使 disabled 也轮询，故 RAII 构造时无条件调用；内部每 N 次才真读）。
void MaybePoll();

// 记录一次调用。name = 编译期字面量 "Interface.member"；kind: 0=method,1=getter。
// argv/argc = 入参（getter 传 nullptr/0）；rval = 返回值/属性值。
void RecordNamed(JSContext* cx, const char* name, int kind, const JS::Value* argv,
                 unsigned argc, JS::Handle<JS::Value> rval);

// 方法体顶部注入：析构(函数返回，rval 已设)时记录 入参 + 返回值。
class AutoTraceMethod {
  JSContext* mCx;
  const JSJitMethodCallArgs* mArgs;
  const char* mName;

 public:
  AutoTraceMethod(JSContext* cx, const JSJitMethodCallArgs& args, const char* name)
      : mCx(cx), mArgs(&args), mName(name) {
    MaybePoll();
  }
  ~AutoTraceMethod() {
    if (!gEnabled) {
      return;
    }
    unsigned n = mArgs->length();
    if (n > 16) {
      n = 16;
    }
    JS::Value argv[16];
    for (unsigned i = 0; i < n; i++) {
      argv[i] = mArgs->get(i);
    }
    JS::Rooted<JS::Value> rv(mCx, mArgs->rval());
    RecordNamed(mCx, mName, 0, argv, n, rv);
  }
};

// getter 体顶部注入：getter 无入参，只记返回(属性)值。
class AutoTraceGetter {
  JSContext* mCx;
  JSJitGetterCallArgs mArgs;
  const char* mName;

 public:
  AutoTraceGetter(JSContext* cx, JSJitGetterCallArgs args, const char* name)
      : mCx(cx), mArgs(args), mName(name) {
    MaybePoll();
  }
  ~AutoTraceGetter() {
    if (!gEnabled) {
      return;
    }
    JS::Rooted<JS::Value> rv(mCx, mArgs.rval());
    RecordNamed(mCx, mName, 1, nullptr, 0, rv);
  }
};

}  // namespace webapitrace
}  // namespace mozilla

#endif  // mozilla_dom_WebApiTraceCore_h
