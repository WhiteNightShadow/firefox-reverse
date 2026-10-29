#!/usr/bin/env python3
"""
Apply Phase B JSVMP trace patches to firefox upstream.
Idempotent: re-running is safe (does nothing if already applied).

Usage: python3 apply-phase-b.py <firefox-src-root>
"""

import sys
import os

if len(sys.argv) != 2:
    print("Usage: apply-phase-b.py <firefox-src-root>", file=sys.stderr)
    sys.exit(1)

ROOT = sys.argv[1]


def patch_file(path, transformations):
    """Apply a list of (description, old, new) tuples to a file."""
    content = open(path, encoding="utf-8").read()
    changed = False
    for desc, old, new in transformations:
        if new in content:
            print(f"  [skip] {desc} (already applied)")
            continue
        if old not in content:
            print(f"  [FAIL] {desc}: old pattern not found", file=sys.stderr)
            sys.exit(1)
        content = content.replace(old, new, 1)
        changed = True
        print(f"  [done] {desc}")
    if changed:
        open(path, "w", encoding="utf-8").write(content)


# ---------------------------------------------------------------------------
# 1. js/src/vm/moz.build: 加 JsvmpTraceCore.cpp 到 UNIFIED_SOURCES
#    （字母顺序：JSScript.cpp 后，List.cpp 前）
# ---------------------------------------------------------------------------
moz_path = os.path.join(ROOT, "js/src/vm/moz.build")
print(f"==> {moz_path}")
patch_file(moz_path, [
    (
        "add JsvmpTraceCore.cpp to UNIFIED_SOURCES",
        '    "JSScript.cpp",\n',
        '    "JSScript.cpp",\n    "JsvmpTraceCore.cpp",\n',
    ),
])


# ---------------------------------------------------------------------------
# 2. js/src/vm/Interpreter.cpp: 加 include + EnsureInit + 改 ADVANCE_AND_DISPATCH
# ---------------------------------------------------------------------------
ipath = os.path.join(ROOT, "js/src/vm/Interpreter.cpp")
print(f"==> {ipath}")

OLD_MACRO = (
    '#define ADVANCE_AND_DISPATCH(N)                  \\\n'
    '  JS_BEGIN_MACRO                                 \\\n'
    '    REGS.pc += (N);                              \\\n'
    '    SANITY_CHECKS();                             \\\n'
    '    DISPATCH_TO(*REGS.pc | activation.opMask()); \\\n'
    '  JS_END_MACRO'
)
NEW_MACRO = (
    '#define ADVANCE_AND_DISPATCH(N)                  \\\n'
    '  JS_BEGIN_MACRO                                 \\\n'
    '    REGS.pc += (N);                              \\\n'
    '    JSVMP_TRACE_OPCODE();                        \\\n'
    '    SANITY_CHECKS();                             \\\n'
    '    DISPATCH_TO(*REGS.pc | activation.opMask()); \\\n'
    '  JS_END_MACRO'
)

OLD_INTERPRET_FN = (
    'bool MOZ_NEVER_INLINE JS_HAZ_JSNATIVE_CALLER js::Interpret(JSContext* cx,\n'
    '                                                           RunState& state) {\n'
)
NEW_INTERPRET_FN = OLD_INTERPRET_FN + '  mozilla::jsvmp::EnsureInit();\n'

patch_file(ipath, [
    (
        "add include for JsvmpTraceCore.h",
        '#include "jit/JitZone.h"\n',
        '#include "jit/JitZone.h"\n#include "vm/JsvmpTraceCore.h"\n',
    ),
    (
        "add EnsureInit() at top of js::Interpret()",
        OLD_INTERPRET_FN,
        NEW_INTERPRET_FN,
    ),
    (
        "insert JSVMP_TRACE_OPCODE() into ADVANCE_AND_DISPATCH macro",
        OLD_MACRO,
        NEW_MACRO,
    ),
])

# ---------------------------------------------------------------------------
# 3. dom/bindings/moz.build: 加 WebApiTraceCore.cpp 到 SOURCES（非 unified，独立 TU，
#    避免匿名命名空间符号在 unified 构建里与其它文件冲突）
# ---------------------------------------------------------------------------
dom_moz = os.path.join(ROOT, "dom/bindings/moz.build")
print(f"==> {dom_moz}")
patch_file(dom_moz, [
    (
        "export WebApiTraceCore.h (sorted position: 'WebApi' < 'WebIDL')",
        '    "WebIDLGlobalNameHash.h",\n',
        '    "WebApiTraceCore.h",\n    "WebIDLGlobalNameHash.h",\n',
    ),
    (
        "add WebApiTraceCore.cpp to SOURCES",
        'FINAL_LIBRARY = "xul"',
        'SOURCES += [\n    "WebApiTraceCore.cpp",\n]\n\nFINAL_LIBRARY = "xul"',
    ),
])

# ---------------------------------------------------------------------------
# 4. dom/bindings/BindingUtils.h: #include WebApiTraceCore.h，让**所有生成的 binding**
#    都能用 AutoTrace*（有方法/getter 代码的 binding 都 include BindingUtils.h）。
# ---------------------------------------------------------------------------
buhpath = os.path.join(ROOT, "dom/bindings/BindingUtils.h")
print(f"==> {buhpath}")
patch_file(buhpath, [
    (
        "add include for WebApiTraceCore.h in BindingUtils.h",
        '#include "js/experimental/JitInfo.h"  // JSJitGetterOp, JSJitInfo\n',
        '#include "js/experimental/JitInfo.h"  // JSJitGetterOp, JSJitInfo\n'
        '#include "mozilla/dom/WebApiTraceCore.h"  // firefox-reverse: 通用 Web-API 调用追踪\n',
    ),
])

# ---------------------------------------------------------------------------
# 5. dom/bindings/Codegen.py: 在每个 WebIDL 方法/getter 生成体顶部注入 RAII
#    (AutoTraceMethod/AutoTraceGetter)。注入点 = definition_prologue 里 profiler_label
#    之后（profiler_label 非空 ⇔ 是 binding method/getter，且此处 cx/args 必有效）。
#    接口名+成员名取编译期字面量。覆盖 generic(经 trampoline 调生成体)+specialized(XHR)。
# ---------------------------------------------------------------------------
cgpath = os.path.join(ROOT, "dom/bindings/Codegen.py")
print(f"==> {cgpath}")

CG_OLD = (
    "        profiler_label = self.auto_profiler_label()\n"
    "        if profiler_label:\n"
    '            prologue += indent(profiler_label) + "\\n"\n'
    "\n"
    "        return prologue\n"
)
CG_NEW = (
    "        profiler_label = self.auto_profiler_label()\n"
    "        if profiler_label:\n"
    '            prologue += indent(profiler_label) + "\\n"\n'
    "            # firefox-reverse: 注入通用 Web-API 调用追踪(RAII，引擎层、JS 不可检测)。\n"
    "            _frx_member = getattr(self, \"method\", None) or getattr(self, \"attr\", None)\n"
    "            _frx_desc = getattr(self, \"descriptor\", None)\n"
    "            _frx_isstatic = getattr(_frx_member, \"isStatic\", None)\n"
    "            if (_frx_member is not None and _frx_desc is not None\n"
    "                    and not (_frx_isstatic and _frx_isstatic())):\n"
    "                _frx_nm = \"%s.%s\" % (\n"
    "                    _frx_desc.interface.identifier.name,\n"
    "                    _frx_member.identifier.name,\n"
    "                )\n"
    "                if \"STRING_TEMPLATE_GETTER\" in profiler_label:\n"
    "                    prologue += indent(\n"
    "                        'mozilla::webapitrace::AutoTraceGetter _wat_frx(cx, args, \"%s\");\\n'\n"
    "                        % _frx_nm\n"
    "                    )\n"
    "                elif \"STRING_TEMPLATE_METHOD\" in profiler_label:\n"
    "                    prologue += indent(\n"
    "                        'mozilla::webapitrace::AutoTraceMethod _wat_frx(cx, args, \"%s\");\\n'\n"
    "                        % _frx_nm\n"
    "                    )\n"
    "\n"
    "        return prologue\n"
)

patch_file(cgpath, [
    (
        "inject webapi AutoTrace into Codegen.py definition_prologue",
        CG_OLD,
        CG_NEW,
    ),
])

# ---------------------------------------------------------------------------
# 6. browser/app/nsBrowserApp.cpp: Windows 下父进程启动最早期注入
#    MOZ_DISABLE_CONTENT_SANDBOX=1。关闭内容沙箱是本浏览器的核心配置：沙箱会挡住引擎层 trace
#    往 %TEMP% 写 NDJSON (fopen 静默失败)。mac/Linux 靠 0001 的 security.sandbox.content.level=0
#    即可；Windows 会把这个 pref 一律抬到 6（Nightly 也一样），只能用环境变量：父进程据此算出
#    级别 0，启动内容进程时就不套沙箱。所以要在 main() 最早注入，早于任何子进程启动。
#    mac/Linux 无 XP_WIN → 不编译此段。注入的文本别改：已打过的树靠原文判断跳过。
# ---------------------------------------------------------------------------
nbapath = os.path.join(ROOT, "browser/app/nsBrowserApp.cpp")
print(f"==> {nbapath}")
patch_file(nbapath, [
    (
        "inject MOZ_DISABLE_CONTENT_SANDBOX into nsBrowserApp main (Windows)",
        "int main(int argc, char* argv[], char* envp[]) {\n",
        "int main(int argc, char* argv[], char* envp[]) {\n"
        "#if defined(XP_WIN)\n"
        "  // firefox-reverse: content sandbox on Windows blocks engine-layer trace from writing\n"
        "  // NDJSON to %TEMP% (fopen fails). content sandbox level is already 0 but release builds\n"
        "  // clamp the pref. Inject MOZ_DISABLE_CONTENT_SANDBOX=1 at earliest parent startup\n"
        "  // (content procs inherit it) so jsvmp/webapi trace can persist to disk.\n"
        '  _putenv("MOZ_DISABLE_CONTENT_SANDBOX=1");\n'
        "#endif\n",
    ),
])

# ---------------------------------------------------------------------------
# 7. page_determinism：同一个种子让文档的 Math.random、crypto.getRandomValues、
#    crypto.randomUUID 每次都给出同一串值。Math.random 直接设 realm 自己的 xorshift128+
#    状态（JIT 内联的 Math.random 读的也是它，页面看不出被改过）；crypto 在 Crypto 对象上
#    挂一条按文档的序列。种子推导和取数规则在 additions/dom/base/FrxDeterministicRandom.h，
#    工具在 Node 里按同样规则复现，两边要一起改。声明放新的 js/friend/MathRandom.h，
#    不碰 jsapi.h 引入的 js/Realm.h，免得全量重编。
# ---------------------------------------------------------------------------
jsmoz = os.path.join(ROOT, "js/src/moz.build")
print(f"==> {jsmoz}")
patch_file(jsmoz, [
    (
        "export js/friend/MathRandom.h",
        '    "../public/friend/JSMEnvironment.h",\n',
        '    "../public/friend/JSMEnvironment.h",\n'
        '    "../public/friend/MathRandom.h",\n',
    ),
])

realmpath = os.path.join(ROOT, "js/src/vm/Realm.cpp")
print(f"==> {realmpath}")
patch_file(realmpath, [
    (
        "include js/friend/MathRandom.h in Realm.cpp",
        '#include "js/friend/ErrorMessages.h"  // js::GetErrorMessage, JSMSG_*\n',
        '#include "js/friend/ErrorMessages.h"  // js::GetErrorMessage, JSMSG_*\n'
        '#include "js/friend/MathRandom.h"     // js::SetRealmMathRandomState\n',
    ),
    (
        "add js::SetRealmMathRandomState",
        "  GenerateXorShift128PlusSeed(seed);\n"
        "  rng.setState(seed[0], seed[1]);\n"
        "}\n",
        "  GenerateXorShift128PlusSeed(seed);\n"
        "  rng.setState(seed[0], seed[1]);\n"
        "}\n"
        "\n"
        "JS_PUBLIC_API void js::SetRealmMathRandomState(JSContext* cx,\n"
        "                                               uint64_t state0,\n"
        "                                               uint64_t state1) {\n"
        "  MOZ_ASSERT(cx->realm());\n"
        "  cx->realm()->getOrCreateRandomNumberGenerator().setState(state0, state1);\n"
        "}\n",
    ),
])

cryptoh = os.path.join(ROOT, "dom/base/Crypto.h")
print(f"==> {cryptoh}")
patch_file(cryptoh, [
    (
        "include Maybe and XorShift128PlusRNG in Crypto.h",
        '#include "mozilla/dom/SubtleCrypto.h"\n',
        '#include "mozilla/Maybe.h"\n'
        '#include "mozilla/XorShift128PlusRNG.h"\n'
        '#include "mozilla/dom/SubtleCrypto.h"\n',
    ),
    (
        "add Crypto::SetDeterministicStream",
        "  nsIGlobalObject* GetParentObject() const { return mParent; }\n",
        "  nsIGlobalObject* GetParentObject() const { return mParent; }\n"
        "\n"
        "  // firefox-reverse page_determinism: getRandomValues and randomUUID draw\n"
        "  // from this stream instead of the system RNG until it is reset.\n"
        "  void SetDeterministicStream(\n"
        "      const Maybe<non_crypto::XorShift128PlusRNG>& aStream) {\n"
        "    mDeterministicStream = aStream;\n"
        "  }\n",
    ),
    (
        "add Crypto::mDeterministicStream",
        "  RefPtr<SubtleCrypto> mSubtle;\n",
        "  RefPtr<SubtleCrypto> mSubtle;\n"
        "  Maybe<non_crypto::XorShift128PlusRNG> mDeterministicStream;\n",
    ),
])

cryptocpp = os.path.join(ROOT, "dom/base/Crypto.cpp")
print(f"==> {cryptocpp}")
patch_file(cryptocpp, [
    (
        "include FrxDeterministicRandom.h in Crypto.cpp",
        '#include "mozilla/dom/CryptoBinding.h"\n',
        '#include "mozilla/dom/CryptoBinding.h"\n'
        '#include "mozilla/dom/FrxDeterministicRandom.h"\n',
    ),
    (
        "getRandomValues draws from the deterministic stream",
        "    nsresult rv = randomGenerator->GenerateRandomBytesInto(aData.Elements(),\n",
        "    if (mDeterministicStream) {\n"
        "      frx::FillDeterministic(*mDeterministicStream, aData);\n"
        "      aRetval.set(aArray.Obj());\n"
        "      return;\n"
        "    }\n"
        "\n"
        "    nsresult rv = randomGenerator->GenerateRandomBytesInto(aData.Elements(),\n",
    ),
    (
        "randomUUID draws from the deterministic stream",
        "  nsIDToCString uuidString(nsID::GenerateUUID());\n",
        "  nsIDToCString uuidString(mDeterministicStream\n"
        "                               ? frx::DeterministicUUID(*mDeterministicStream)\n"
        "                               : nsID::GenerateUUID());\n",
    ),
])

cuwebidl = os.path.join(ROOT, "dom/chrome-webidl/ChromeUtils.webidl")
print(f"==> {cuwebidl}")
patch_file(cuwebidl, [
    (
        "declare ChromeUtils.setDeterministicRandom",
        "\n[Exposed=Window]\npartial namespace ChromeUtils {\n",
        "\n[Exposed=Window]\npartial namespace ChromeUtils {\n"
        "  /**\n"
        "   * firefox-reverse page_determinism: makes Math.random,\n"
        "   * crypto.getRandomValues and crypto.randomUUID of |window|'s current\n"
        "   * document repeatable from |seed|. An empty seed restores real randomness.\n"
        "   */\n"
        "  [Throws]\n"
        "  undefined setDeterministicRandom(Window window, UTF8String seed);\n"
        "\n",
    ),
])

cuh = os.path.join(ROOT, "dom/base/ChromeUtils.h")
print(f"==> {cuh}")
patch_file(cuh, [
    (
        "forward-declare nsGlobalWindowInner in ChromeUtils.h",
        "class nsIRFPTargetSetIDL;\n",
        "class nsGlobalWindowInner;\nclass nsIRFPTargetSetIDL;\n",
    ),
    (
        "declare ChromeUtils::SetDeterministicRandom",
        "  static void IdleDispatch(const GlobalObject& global,\n",
        "  static void SetDeterministicRandom(const GlobalObject& aGlobal,\n"
        "                                     nsGlobalWindowInner& aWindow,\n"
        "                                     const nsACString& aSeed,\n"
        "                                     ErrorResult& aRv);\n"
        "\n"
        "  static void IdleDispatch(const GlobalObject& global,\n",
    ),
])

cucpp = os.path.join(ROOT, "dom/base/ChromeUtils.cpp")
print(f"==> {cucpp}")
patch_file(cucpp, [
    (
        "include FrxDeterministicRandom.h in ChromeUtils.cpp",
        '#include "mozilla/dom/ContentParent.h"\n',
        '#include "mozilla/dom/ContentParent.h"\n'
        '#include "mozilla/dom/FrxDeterministicRandom.h"\n',
    ),
    (
        "define ChromeUtils::SetDeterministicRandom",
        "/* static */\nvoid ChromeUtils::IdleDispatch(const GlobalObject& aGlobal,\n",
        "/* static */\n"
        "void ChromeUtils::SetDeterministicRandom(const GlobalObject& aGlobal,\n"
        "                                         nsGlobalWindowInner& aWindow,\n"
        "                                         const nsACString& aSeed,\n"
        "                                         ErrorResult& aRv) {\n"
        "  frx::SetDeterministicRandom(aWindow, aSeed, aRv);\n"
        "}\n"
        "\n"
        "/* static */\nvoid ChromeUtils::IdleDispatch(const GlobalObject& aGlobal,\n",
    ),
])

dombasemoz = os.path.join(ROOT, "dom/base/moz.build")
print(f"==> {dombasemoz}")
patch_file(dombasemoz, [
    (
        "export FrxDeterministicRandom.h",
        '    "FromParser.h",\n',
        '    "FromParser.h",\n    "FrxDeterministicRandom.h",\n',
    ),
    (
        # 别用 apply-fingerprint-config.py 已经用过的锚点：两边插在同一处会互相破坏"已应用"判断。
        "add FrxDeterministicRandom.cpp",
        "# Are we targeting x86-32 or x86-64?  If so, we want to include SSE2 code for\n",
        'SOURCES += [\n    "FrxDeterministicRandom.cpp",\n]\n\n'
        "# Are we targeting x86-32 or x86-64?  If so, we want to include SSE2 code for\n",
    ),
])

print("\nAll Phase B patches applied successfully.")
