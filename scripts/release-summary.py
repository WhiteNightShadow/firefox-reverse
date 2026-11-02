#!/usr/bin/env python3
"""Write docs/verification/release-v<version>/summary.json (docs/release-process.md step 8) from a release spec.

usage: release-summary.py <spec.json> <output summary.json>

The spec lists where this release's evidence is; it holds machine paths, so keep it outside the repository:
{
  "version": "0.27.0", "releaseKind": "release", "sourceCommit": "<40 hex>", "buildID": "<14 digits>",
  "packages": ["<path of each final package>", ...],
  "nativeCI": {"run": "<actions run URL>", "mcpCommit": "<frx-director-mcp commit>", "artifacts": "<gh run download dir>",
               "runners": {"<target>": "<runner>", ...}},            # runners optional, defaults to the four CI targets
  "buildHost": "<one line, no machine names>",
  "local": [{"target": "<target>", "host": <text or object>, "reports": "<report dir>",
             "signature": "<macOS only, optional>", "prepareLog": "<prepare-native-candidate output, optional>"}, ...],
  "windowsInstallerCheck": "<windows-installer-check.json>",           # optional
  "inPlaceUpgrade": {"target": "macos-arm64", "from": "<old build>", "baseline": "<--counts-only report>",
                     "after": "<full report>", "installedCheck": "<optional JSON written after the run>"},   # optional
  "buildRecords": ["build-record.<target>.json", ...], "buildRecordsNote": "<optional>",
  "limitations": ["...", ...]
}
A report dir is what scripts/release-accept.sh or scripts/release-accept-windows-vm.sh wrote (acceptance.json and
the check reports); older dirs without acceptance.json work too, with the package identity taken from prepareLog.
Only counts, states, hashes and host descriptions are written: no profile names, cookie or bookmark data.
Missing or failing evidence is listed under "pending" and makes the status "incomplete"; the exit code is then 1.
"""
import hashlib
import json
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_spec = spec_from_file_location("release_reports", Path(__file__).with_name("release-reports.py"))
reports = module_from_spec(_spec)
_spec.loader.exec_module(reports)

DEFAULT_RUNNERS = {"windows-x86_64": "windows-latest", "linux-x86_64": "ubuntu-24.04", "linux-arm64": "ubuntu-24.04-arm", "macos-x86_64": "macos-15-intel"}
TARGETS = ["macos-arm64", "macos-x86_64", "windows-x86_64", "linux-x86_64", "linux-arm64"]
CHECK_COUNTS = ["nativeFingerprintAssertions", "pageAndAgentAssertions", "environmentLifecycle", "globalSystemPromptScenarios",
                "syntheticModelRequests", "browserExitCodes", "packageUnchanged"]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def trailing_json(path):
    """The JSON object a log ends with (prepare-native-candidate prints its report last)."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        return json.loads(text[text.index("{"):])
    except (OSError, ValueError):
        return None


class Summary:
    def __init__(self, spec):
        self.spec = spec
        self.commit = spec["sourceCommit"]
        self.build_id = spec["buildID"]
        self.pending = []

    def run_result(self, directory, label, prepare_log=None):
        """Status, package identity and counts of one acceptance or CI report directory."""
        directory = Path(directory)
        found = reports.read(directory, self.commit, self.build_id)
        verdicts, counts = found["verdicts"], found["counts"]
        acceptance = reports.load(directory / "acceptance.json")
        identity = None
        if "package-identity" in verdicts:
            identity = verdicts["package-identity"]
        elif prepare_log:
            report = trailing_json(prepare_log)
            identity = bool(report) and report.get("status") == "passed" and report.get("sourceCommit") == self.commit and report.get("buildID") == self.build_id
            if identity:
                counts["sidebarModules"] = len(report.get("modules", []))
                counts["binaryArchitecture"] = report.get("binaryArchitecture")
        needed = ["page-interaction", "lifecycle", "fingerprint", "global-prompt"]
        missing = [name for name in needed if name not in verdicts]
        failed = [name for name, ok in verdicts.items() if not ok]
        if acceptance and acceptance.get("status") != "passed":
            failed.append("acceptance.json")
        if identity is None:
            missing.append("package-identity")
        if missing:
            self.pending.append(f"{label}: missing {', '.join(missing)} in {directory}")
        if failed:
            self.pending.append(f"{label}: {', '.join(failed)} did not pass")
        result = {}
        if identity is not None:
            result["packageIdentity"] = (
                f"passed ({counts.get('sidebarModules')} sidebar modules, {counts.get('binaryArchitecture')})" if identity else "failed"
            )
        result["status"] = "passed" if not missing and not failed else "failed" if failed else "incomplete"
        result.update({key: counts[key] for key in CHECK_COUNTS if key in counts})
        if "macOSAppDataNativeScenarios" in counts:
            result["macOSAppDataNativeScenarios"] = counts["macOSAppDataNativeScenarios"]
        if "windowsPackage" in counts:
            result["windowsPackage"] = counts["windowsPackage"]
        if acceptance and acceptance.get("packageAfterRun"):
            result["packageAfterRun"] = acceptance["packageAfterRun"]
        return result

    def packages(self):
        out = {}
        for path in self.spec.get("packages", []):
            path = Path(path)
            if path.is_file():
                out[path.name] = sha256(path)
            else:
                self.pending.append(f"package missing: {path}")
        if len(out) != 6:
            self.pending.append(f"expected six packages, have {len(out)}")
        return dict(sorted(out.items()))

    def native_ci(self):
        ci = self.spec.get("nativeCI") or {}
        runners = ci.get("runners") or DEFAULT_RUNNERS
        artifacts = Path(ci["artifacts"]) if ci.get("artifacts") else None
        results = {}
        for target, runner in runners.items():
            if artifacts is None:
                self.pending.append(f"native CI {target}")
                results[target] = {"runner": runner, "status": "pending"}
                continue
            results[target] = {"runner": runner, **self.run_result(artifacts / f"native-{target}-report", f"native CI {target}")}
        if artifacts is not None and "windows-x86_64" in runners:
            native = reports.windows_native_report(artifacts / "windows-native-report")
            if native and native.get("status") == "passed" and native.get("source_commit") == self.commit and native.get("runtime_build_id") == self.build_id:
                results["windows-x86_64"]["windowsPackage"] = {
                    "screenshotRuns": len(native.get("screenshot_runs", [])),
                    "ledgerChecks": len(native.get("ledger_checks", [])),
                    "msvcRuntimeInPackage": native.get("msvc_runtime"),
                }
            else:
                self.pending.append("native CI windows package job report")
        if not ci.get("run"):
            self.pending.append("native CI run URL")
        return {"run": ci.get("run"), "mcpCommit": ci.get("mcpCommit"), "results": results}

    def local(self):
        out = {}
        if self.spec.get("buildHost"):
            out["buildHost"] = self.spec["buildHost"]
        for entry in self.spec.get("local", []):
            target = entry["target"]
            result = {"host": entry.get("host")}
            if entry.get("signature"):
                result["signature"] = entry["signature"]
            run = self.run_result(entry["reports"], f"local {target} ({Path(entry['reports']).name})", entry.get("prepareLog"))
            if "packageIdentity" in run:
                result["packageIdentity"] = run.pop("packageIdentity")
            for key in ("macOSAppDataNativeScenarios", "windowsPackage", "packageAfterRun"):
                if key in run:
                    result[key] = run.pop(key)
            result["checks"] = run
            if target in out:
                out[target] = (out[target] if isinstance(out[target], list) else [out[target]]) + [result]
            else:
                out[target] = result
        installer_path = self.spec.get("windowsInstallerCheck")
        if installer_path:
            installer = reports.load(installer_path)
            if installer and installer.get("status") == "passed":
                out["windows-installer"] = f"static payload comparison passed: {installer.get('files')} files identical between the installer's core/ and the zip"
            else:
                self.pending.append("windows installer static check")
        upgrade = self.spec.get("inPlaceUpgrade")
        if upgrade:
            key = upgrade.get("target", "macos-arm64")
            entry = out.get(key)
            if isinstance(entry, dict):
                entry[f"inPlaceUpgradeFrom{upgrade.get('from', 'previous')}"] = self.in_place_upgrade(upgrade)
            else:
                self.pending.append(f"in-place upgrade: no local {key} entry to attach it to")
        return out

    def in_place_upgrade(self, spec):
        """Booleans only, like v0.26.2's inPlaceUpgradeFromV0261: no profile name, no counts."""
        baseline, after = reports.load(spec.get("baseline", "")), reports.load(spec.get("after", ""))
        if not baseline or not after:
            self.pending.append("in-place upgrade reports")
            return "pending"
        same_counts = baseline.get("before") == after.get("before") == after.get("after")
        result = {
            "status": after.get("status"),
            "sameProfile": baseline["app"]["profile"] == after["app"]["profile"],
            "runningRelease": after["app"]["buildID"] == self.build_id and after["app"]["version"] == self.spec["version"],
            "profileOpenedByThisBuild": after["app"]["lastVersion"].endswith("/" + self.build_id),
            "bookmarksModelProfilesEnvironmentsUnchanged": same_counts,
            "environmentQuitChannel": "passed" if (after.get("temporaryEnvironment") or {}).get("closedBy") == "quit-channel" else "failed",
            "checks": len(after.get("checks", [])),
        }
        installed = reports.load(spec["installedCheck"]) if spec.get("installedCheck") else None
        if installed:
            result["installedAppAfterRun"] = installed
        if after.get("status") != "passed" or not same_counts or not result["sameProfile"] or not result["runningRelease"]:
            self.pending.append("in-place upgrade did not pass")
        return result

    def build(self):
        spec = self.spec
        summary = {
            "schemaVersion": 1,
            "status": None,
            "release": f"v{spec['version']}",
            "releaseKind": spec.get("releaseKind", "release"),
            "sourceCommit": self.commit,
            "buildID": self.build_id,
            "packages": self.packages(),
            "nativeCI": self.native_ci(),
            "local": self.local(),
            "buildRecords": spec.get("buildRecords", [f"build-record.{t}.json" for t in TARGETS]),
        }
        if spec.get("buildRecordsNote"):
            summary["buildRecordsNote"] = spec["buildRecordsNote"]
        summary["limitations"] = spec.get("limitations", [])
        summary["status"] = "passed" if not self.pending else "incomplete"
        if self.pending:
            summary["pending"] = self.pending
        return summary


def main(argv):
    if len(argv) != 2:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    spec = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    summary = Summary(spec).build()
    output = Path(argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": summary["status"], "pending": summary.get("pending", [])}, indent=1, ensure_ascii=False))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
