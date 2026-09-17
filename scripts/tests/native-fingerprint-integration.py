#!/usr/bin/env python3
"""Structural regression guards; not a replacement for native browser tests."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys

repository = Path(__file__).resolve().parents[2]
upstream = Path(sys.argv[1]).resolve()
parent = (upstream / "dom/ipc/ContentParent.cpp").read_text()
launch = parent[parent.index("bool ContentParent::BeginSubprocessLaunch("):]
assert launch.index("PrepareContentSnapshot(") < launch.index("SetEnv(\"MOZ_FRX_PARENT_CONFIG_TOKEN\"") < launch.index("mPrefSerializer = MakeUnique")
child = (upstream / "dom/ipc/ContentProcess.cpp").read_text()
assert child.index("NS_InitXPCOM failed") < child.index("FrxFingerprintConfig::GetStatus()") < child.index('NS_CreateServicesFromCategory("app-startup"')
audio = (upstream / "dom/media/webaudio/AudioDestinationNode.cpp").read_text()
finalize = audio[audio.index("already_AddRefed<AudioBuffer> CreateAudioBuffer("):audio.index("class DestinationNodeEngine")]
assert "if (!mFrxAudioFinalized)" in finalize
assert finalize.index("mFrxAudioFinalized = true") < finalize.index("FrxTransformOfflineAudioChannel(") < finalize.index("RefPtr<AudioBuffer> renderedBuffer")
assert audio.count("FrxTransformOfflineAudioChannel(") == 1
assert "GetChannelData" not in finalize

# Reapply only on the caller's explicit integration fixture. No installed
# Firefox or production profile is involved.
files = ["modules/libpref/init/StaticPrefList.yaml", "dom/ipc/ContentParent.cpp", "dom/ipc/ContentProcess.cpp", "dom/media/webaudio/AudioDestinationNode.cpp", "gfx/thebes/gfxPlatformFontList.cpp", "gfx/thebes/gfxUserFontSet.cpp"]
digest = lambda name: hashlib.sha256((upstream / name).read_bytes()).hexdigest()
before = {name: digest(name) for name in files}
subprocess.run([sys.executable, str(repository / "scripts/apply-fingerprint-config.py"), str(upstream)], cwd=repository, stdout=subprocess.DEVNULL, check=True)
assert before == {name: digest(name) for name in files}, "native patch application was not idempotent"
print("Native integration guards passed: parent serializer ordering, child XPCOM warmup, one-shot offline PCM, patch idempotency")
