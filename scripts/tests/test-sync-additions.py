"""sync-additions.py: copy changed files only, prune what additions/ dropped, restore overridden upstream files."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/sync-additions.py"


def run(additions, upstream, *extra):
    return subprocess.run([sys.executable, str(SCRIPT), str(additions), str(upstream), *extra],
                          check=True, capture_output=True, text=True).stdout


class SyncAdditionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frx-sync-additions-")
        root = Path(self.temp.name)
        self.additions = root / "additions"
        self.upstream = root / "upstream"
        (self.upstream / "browser/branding").mkdir(parents=True)
        (self.upstream / "browser/branding/brand.ftl").write_text("upstream brand\n")
        subprocess.run(["git", "init", "-q", str(self.upstream)], check=True)
        subprocess.run(["git", "-C", str(self.upstream), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.upstream), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                        "commit", "-q", "-m", "base"], check=True)
        files = {
            "dom/base/New.cpp": "new\n",
            "browser/branding/brand.ftl": "overridden brand\n",
            "browser/components/agent-sidebar/modules/A.sys.mjs": "a\n",
            "browser/components/agent-sidebar/content/Panel.jsx": "jsx\n",
            "browser/components/agent-sidebar/dev/selftest.mjs": "dev\n",
            "browser/components/agent-sidebar/README.md": "docs\n",
        }
        for rel, text in files.items():
            path = self.additions / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def tearDown(self):
        self.temp.cleanup()

    def test_copy_skip_prune_and_restore(self):
        run(self.additions, self.upstream)
        self.assertEqual((self.upstream / "dom/base/New.cpp").read_text(), "new\n")
        self.assertEqual((self.upstream / "browser/branding/brand.ftl").read_text(), "overridden brand\n")
        for skipped in ("content/Panel.jsx", "dev/selftest.mjs", "README.md"):
            self.assertFalse((self.upstream / "browser/components/agent-sidebar" / skipped).exists(), skipped)

        target = self.upstream / "dom/base/New.cpp"
        manifest = self.upstream / ".frx-additions-manifest"
        for path in (target, manifest):
            os.utime(path, (1_000_000, 1_000_000))
        output = run(self.additions, self.upstream)
        self.assertEqual(target.stat().st_mtime, 1_000_000, "unchanged files keep their mtime (no rebuild)")
        self.assertEqual(manifest.stat().st_mtime, 1_000_000, "a no-op run writes nothing into the tree")
        self.assertIn("0 copied", output)

        (self.additions / "dom/base/New.cpp").write_text("changed\n")
        os.utime(self.additions / "dom/base/New.cpp", (1_000, 1_000))
        run(self.additions, self.upstream)
        self.assertEqual(target.read_text(), "changed\n")
        self.assertGreater(target.stat().st_mtime, 1_000_000, "changed files get a fresh mtime, not the source's old one")

        (self.additions / "dom/base/New.cpp").unlink()
        (self.additions / "browser/branding/brand.ftl").unlink()
        output = run(self.additions, self.upstream)
        self.assertFalse(target.exists(), "a file dropped from additions is removed from the tree")
        self.assertFalse((self.upstream / "dom").exists(), "empty directories left behind are removed")
        self.assertEqual((self.upstream / "browser/branding/brand.ftl").read_text(), "upstream brand\n",
                         "an overridden upstream file is restored, not deleted")
        self.assertIn("1 stale removed, 1 restored", output)

    def test_excluded_paths_are_left_alone_but_still_tracked(self):
        run(self.additions, self.upstream)
        module = self.upstream / "browser/components/agent-sidebar/modules/A.sys.mjs"
        self.assertTrue(module.exists())
        # A flavor that excludes the sidebar leaves an earlier copy alone, like rsync --exclude: the agent-ui
        # patches that register the directory are not reverted either, so deleting it would break the build.
        output = run(self.additions, self.upstream, "--exclude", "browser/components/agent-sidebar")
        self.assertTrue(module.exists())
        self.assertIn("0 stale removed", output)
        # The file stays tracked: once additions/ drops it, the next full sync still prunes it.
        (self.additions / "browser/components/agent-sidebar/modules/A.sys.mjs").unlink()
        output = run(self.additions, self.upstream)
        self.assertFalse(module.exists())
        self.assertIn("1 stale removed", output)


if __name__ == "__main__":
    unittest.main()
