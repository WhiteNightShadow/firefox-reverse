import hashlib
import importlib.util
from pathlib import Path
import tempfile
import errno
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("diagnostics", Path(__file__).resolve().parents[1] / "diagnose-macos-startup.py")
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "Profiles/现有环境").mkdir(parents=True)
    data = "[Profile0]\nName=private-name\nIsRelative=1\nPath=Profiles/现有环境\nDefault=1\n[InstallPRIVATEHASH]\nDefault=Profiles/deleted\nLocked=1\n"
    (root / "profiles.ini").write_text(data, encoding="utf-8")
    before = hashlib.sha256((root / "profiles.ini").read_bytes()).hexdigest()
    report = diagnostics.profile_registry(root)
    assert report["profiles"][0]["directoryExists"]
    assert not report["installs"][0]["directoryExists"]
    assert "private-name" not in str(report) and "PRIVATEHASH" not in str(report)
    assert hashlib.sha256((root / "profiles.ini").read_bytes()).hexdigest() == before
    assert not diagnostics.profile_registry(root / "absent")["registryExists"]
    environment = diagnostics.startup_environment({"XRE_PROFILE_PATH": "/private/location", "MOZ_FRX_FINGERPRINT_CONFIG": "secret"})
    assert environment["XRE_PROFILE_PATH"] and not environment["MOZ_NEW_INSTANCE"]
    assert "private/location" not in str(environment) and "secret" not in str(environment)
    (root / "profiles.ini").write_text("[Profile0]\nPath=\nDefault=1\n", encoding="utf-8")
    empty = diagnostics.profile_registry(root)["profiles"][0]
    assert not empty["directoryExists"] and not empty["writable"]
    for number, state in ((errno.EACCES, "access-denied"), (errno.EPERM, "access-denied"), (errno.ENOENT, "missing"), (errno.EIO, "io-error"), (errno.ENOSPC, "io-error")):
        with patch.object(Path, "stat", side_effect=OSError(number, "fixture")):
            result = diagnostics.path_state(root)
        assert result["state"] == state and result["errno"] == number
    for number in (errno.EACCES, errno.EPERM, errno.EIO):
        with patch.object(Path, "open", side_effect=OSError(number, "fixture")):
            denied = diagnostics.profile_registry(root)
        assert denied["registryExists"] is None
        assert denied["profiles.iniErrno"] == number
    environment = diagnostics.startup_environment({"MOZ_APP_DATA": "/private/data", "MOZ_LOCAL_APP_DATA": "/private/cache"})
    assert environment["MOZ_APP_DATA"] and environment["MOZ_LOCAL_APP_DATA"]
    assert "/private/" not in str(environment)
print("Startup diagnostics: stale install mapping, Unicode profile, privacy and read-only checks passed")
