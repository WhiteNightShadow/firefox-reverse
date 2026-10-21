"""Check the native policy and pinned patch without editing the source checkout."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import sys

repo = Path(__file__).resolve().parents[2]
upstream = Path(sys.argv[1]) if len(sys.argv) > 1 else repo / "upstream"
baseline = "cebc55aab4d2661d1f6c2d1526362947ec4016c1"
relative = "toolkit/xre/nsXREDirProvider.cpp"
source = subprocess.check_output(["git", "-C", str(upstream), "show", f"{baseline}:{relative}"])
patch = repo / "patches/agent-ui/0006-macos-private-appdata-recovery.patch"
with tempfile.TemporaryDirectory(prefix="frx-appdata-policy-") as temporary:
    root = Path(temporary)
    target = root / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(source)
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=root, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=root, check=True)
    changed = target.read_text()
    block = changed[changed.index("  // Keep explicit roots"):changed.index("  rv = EnsureDirectoryExists(localDir);", changed.index("  // Keep explicit roots"))]
    assert "!gAppData->profile" in block
    assert 'mozilla::EnvHasValue("MOZ_APP_DATA")' in block
    assert 'mozilla::EnvHasValue("MOZ_LOCAL_APP_DATA")' in block
    assert 'GetUserDataDirectory(getter_AddRefs(global), false)' in block
    helper = (repo / "additions/toolkit/xre/FrxMacAppData.h").read_text()
    assert "->Exists(" not in helper, "Exists hides EPERM as false on Unix"
    assert "->OpenANSIFileDesc(" not in helper, "ANSI open hides ENOENT/EPERM as generic failure"
    assert "->OpenNSPRFileDesc(PR_RDONLY" in helper
    assert "Remove(" not in helper and "MoveTo" not in helper and "CopyTo" not in helper
    assert "NS_ERROR_FILE_CORRUPTED" in helper and 'marker->IsSymlink' in helper
    subprocess.run(["git", "apply", "--reverse", str(patch)], cwd=root, check=True)
    assert target.read_bytes() == source
    binary = root / "policy-test"
    subprocess.run([*shlex.split(os.environ.get("CXX", "c++")), "-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", str(repo / "additions/toolkit/xre"), str(repo / "scripts/tests/test-macos-appdata-policy.cpp"), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print("Pinned patch, explicit namespace boundaries and native policy passed; final-package/macOS 27 acceptance still required")
