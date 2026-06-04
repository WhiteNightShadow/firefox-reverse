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
    content = open(path).read()
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
        open(path, "w").write(content)


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

print("\nAll Phase B patches applied successfully.")
