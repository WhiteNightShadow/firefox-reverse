#!/usr/bin/env python3
"""Verdicts and counts from one acceptance run's report directory, shared by scripts/release-accept.sh,
scripts/release-accept-windows-vm.sh and scripts/release-summary.py.

A report directory holds what the checks write, under the names the native CI artifacts use as well:
PACKAGE-IDENTITY.json, PAGE-REPORT.json, ENVIRONMENT-LIFECYCLE.json, FINGERPRINT-REPORT.json,
global-system-prompt/report.json, and where they ran MACOS-APPDATA.json and windows-native-report/.

usage: release-reports.py acceptance --dir <report dir> --target <target> --package <file name> --sha256 <sha>
         --commit <commit> --build-id <id> [--step <name>=passed|failed ...] [--codesign passed|failed]
         --xul-unchanged true|false --leftover <n> [--host <description>]
  writes <dir>/acceptance.json (steps as the runner saw them, verdicts read from the reports, counts, and the state
  of the package after the run) and exits 1 unless everything passed.
"""
import argparse
import json
import platform
import sys
from pathlib import Path


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def windows_native_report(directory):
    """verify-windows-package.py's report; the CI artifact spells the file name in capitals."""
    for name in ("windows-native-report.json", "WINDOWS-NATIVE-REPORT.json"):
        report = load(Path(directory) / name)
        if report:
            return report
    return None


def read(directory, commit=None, build_id=None):
    """{"verdicts": {check: bool}, "counts": {...}} for the reports present in directory; a missing report has
    no verdict. With commit/build_id given, reports that name another build fail."""
    d = Path(directory)
    verdicts = {}
    counts = {}

    def same(value, expected):
        return expected is None or value == expected

    identity = load(d / "PACKAGE-IDENTITY.json")
    if identity:
        verdicts["package-identity"] = (
            identity.get("status") == "passed" and same(identity.get("sourceCommit"), commit) and same(identity.get("buildID"), build_id)
        )
        counts["sidebarModules"] = len(identity.get("modules", []))
        counts["binaryArchitecture"] = identity.get("binaryArchitecture")
    page = load(d / "PAGE-REPORT.json")
    if page:
        verdicts["page-interaction"] = bool(page.get("checks")) and same(page.get("buildID"), build_id)
        counts["pageAndAgentAssertions"] = len(page.get("checks", []))
    life = load(d / "ENVIRONMENT-LIFECYCLE.json")
    if life:
        scenarios = life.get("scenarios") or {}
        if isinstance(scenarios, list):
            scenarios = {s.get("name", f"scenario-{i}"): s for i, s in enumerate(scenarios)}
        verdicts["lifecycle"] = life.get("status") == "passed" and same(life.get("buildID"), build_id)
        counts["environmentLifecycle"] = {name: len(s.get("checks", [])) for name, s in scenarios.items()}
    fingerprint = load(d / "FINGERPRINT-REPORT.json")
    if fingerprint:
        checks = fingerprint.get("checks", [])
        verdicts["fingerprint"] = fingerprint.get("passed") is True and bool(checks) and all(c.get("passed") for c in checks)
        counts["nativeFingerprintAssertions"] = len(checks)
    prompt = load(d / "global-system-prompt" / "report.json")
    if prompt:
        verdicts["global-prompt"] = (
            prompt.get("status") == "passed" and same(prompt.get("source_commit"), commit) and same(prompt.get("build_id"), build_id)
        )
        counts["globalSystemPromptScenarios"] = len(prompt.get("checks", []))
        counts["syntheticModelRequests"] = len(prompt.get("requests", []))
        counts["browserExitCodes"] = prompt.get("browser_exit_codes")
        counts["packageUnchanged"] = prompt.get("package_unchanged")
    appdata = load(d / "MACOS-APPDATA.json")
    if appdata:
        verdicts["macos-appdata"] = appdata.get("status") == "passed"
        counts["macOSAppDataNativeScenarios"] = len(appdata.get("checks", []))
    native = windows_native_report(d / "windows-native-report")
    if native:
        verdicts["windows-package"] = (
            native.get("status") == "passed" and same(native.get("source_commit"), commit) and same(native.get("runtime_build_id"), build_id)
        )
        counts["windowsPackage"] = {
            "screenshotRuns": len(native.get("screenshot_runs", [])),
            "ledgerChecks": len(native.get("ledger_checks", [])),
            "msvcRuntimeInPackage": native.get("msvc_runtime"),
        }
    return {"verdicts": verdicts, "counts": counts}


def acceptance(args):
    steps = {}
    for item in args.step:
        name, _, state = item.partition("=")
        if state not in ("passed", "failed"):
            raise SystemExit(f"--step {item}: expected <name>=passed|failed")
        steps[name] = state
    result = read(args.dir, args.commit, args.build_id)
    after = {"xulUnchanged": args.xul_unchanged == "true", "leftoverBrowserProcesses": args.leftover}
    if args.codesign:
        after["codesign"] = args.codesign
    # Every step that ran must have passed and left a report that passes; a step without its report fails.
    missing = [name for name, state in steps.items() if state == "passed" and name not in result["verdicts"]]
    ok = (
        bool(steps)
        and all(state == "passed" for state in steps.values())
        and not missing
        and all(result["verdicts"].values())
        and after["xulUnchanged"]
        and after["leftoverBrowserProcesses"] == 0
        and after.get("codesign", "passed") == "passed"
    )
    report = {
        "status": "passed" if ok else "failed",
        "target": args.target,
        "package": {"name": args.package, "sha256": args.sha256},
        "sourceCommit": args.commit,
        "buildID": args.build_id,
        "host": args.host or f"{platform.system()} {platform.release()} {platform.machine()}",
        "steps": steps,
        "verdicts": result["verdicts"],
        "counts": result["counts"],
        "packageAfterRun": after,
    }
    if missing:
        report["missingReports"] = missing
    Path(args.dir, "acceptance.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "steps", "counts", "packageAfterRun")}, ensure_ascii=False))
    return 0 if ok else 1


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    acc = sub.add_parser("acceptance")
    acc.add_argument("--dir", required=True, type=Path)
    acc.add_argument("--target", required=True)
    acc.add_argument("--package", required=True)
    acc.add_argument("--sha256", required=True)
    acc.add_argument("--commit", required=True)
    acc.add_argument("--build-id", required=True)
    acc.add_argument("--step", action="append", default=[])
    acc.add_argument("--codesign", choices=["passed", "failed"])
    acc.add_argument("--xul-unchanged", required=True, choices=["true", "false"])
    acc.add_argument("--leftover", required=True, type=int)
    acc.add_argument("--host")
    args = parser.parse_args(argv)
    return acceptance(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
