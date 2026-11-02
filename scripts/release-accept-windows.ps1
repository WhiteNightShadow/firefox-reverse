# Windows acceptance of the final ZIP on the machine this runs on (docs/release-process.md step 6): package identity,
# page interaction, environment lifecycle, native fingerprint, global system prompt and verify-windows-package.py,
# headless and with temporary profiles only. Run it in the logged-on desktop session; over ssh,
# scripts/release-accept-windows-vm.sh starts it through a scheduled task with an interactive principal.
#
# Layout under -Root (default C:\frx):
#   repo\      checkout of the version commit with .git and the built sidebar bundle; the ZIP in repo\candidate\
#   mcp\       built frx-director-mcp (dist\ and package.json)
#   python\    portable Python 3.11+ (optional when python is on PATH)
#   git\       portable Git (optional when git is on PATH)
# Reports go to <Root>\out: run.log (one line per step, ends with DONE), the check reports under the names the
# native CI uses, windows-native-report\, and xul.dll's hash after the run.
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without BOM in the system code page.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Commit,
  [Parameter(Mandatory = $true)][string]$BuildId,
  [Parameter(Mandatory = $true)][string]$PackageSha,
  [string]$Root = "C:\frx",
  [string]$NodeDir = ""
)
$ErrorActionPreference = "Continue"
$out = Join-Path $Root "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out "run.log"
function Log($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $message
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# -join binds looser than +, hence the parentheses.
$env:PATH = ((@("$Root\python", "$Root\git\cmd", $NodeDir) | Where-Object { $_ -and (Test-Path $_) }) -join ";") + ";" + $env:PATH
$env:MOZ_HEADLESS = "1"
Remove-Item Env:\MOZ_DISABLE_CONTENT_SANDBOX -ErrorAction SilentlyContinue
$env:RELEASE_TAG = $Tag
$env:SOURCE_COMMIT = $Commit
$env:EXPECTED_BUILD_ID = $BuildId
$env:PACKAGE_SHA256 = $PackageSha
$env:PACKAGE_TARGET = "windows-x86_64"
$package = "firefox-reverse-$Tag-windows-x86_64.zip"
$env:PACKAGE_CHECKSUMS = '{"' + $package + '":"' + $PackageSha + '"}'
$env:GITHUB_ENV = Join-Path $out "github-env"
$repo = Join-Path $Root "repo"
$mcp = Join-Path $Root "mcp"
$env:EXPECTED_SIDEBAR_BUNDLE = Join-Path $repo "additions\browser\components\agent-sidebar\content\agent-sidebar.bundle.js"
Set-Location $repo
$os = Get-CimInstance Win32_OperatingSystem
Log ("host: " + $os.Caption + " " + $os.Version + " " + $os.OSArchitecture)
Log ("tools: node " + (& node --version) + ", python " + (& python --version 2>&1) + ", git " + (& git --version))
Remove-Item -Force -ErrorAction SilentlyContinue $env:GITHUB_ENV
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $repo "native-report"), (Join-Path $repo "candidate-stage")

# Step <name> <report that must exist afterwards> <command>: a missing report fails the step even on exit 0.
function Step($name, $report, $command) {
  Log "=== $name"
  $stepLog = Join-Path $out "$name.log"
  try { & cmd.exe /c "$command > `"$stepLog`" 2>&1"; $code = $LASTEXITCODE } catch { $code = 1 }
  if ($code -eq 0 -and (Test-Path $report)) {
    Log "PASS $name"
  } else {
    Log "FAIL $name (exit $code)"
    Get-Content $stepLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Log "  | $_" }
  }
}

Step "package-identity" $env:GITHUB_ENV "python scripts\prepare-native-candidate.py"
$identity = Join-Path $repo "native-report\PACKAGE-IDENTITY.json"
if (Test-Path $identity) { Copy-Item -Force $identity (Join-Path $out "PACKAGE-IDENTITY.json") }
if (Test-Path $env:GITHUB_ENV) {
  Get-Content $env:GITHUB_ENV | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path ("env:" + $matches[1]) -Value $matches[2] } }
  Log ("binary: " + $env:FRX_TEST_BINARY)
  Step "page-interaction" "$out\PAGE-REPORT.json" "node scripts\verify-page-interaction.mjs --firefox `"$env:FRX_TEST_BINARY`" --xul-sha256 $env:FRX_TEST_XUL_SHA --mcp-root `"$mcp`" --output `"$out\PAGE-REPORT.json`" --screenshot `"$out\page-fixture.png`""
  Step "lifecycle" "$out\ENVIRONMENT-LIFECYCLE.json" "node scripts\verify-environment-lifecycle.mjs --firefox `"$env:FRX_TEST_BINARY`" --xul-sha256 $env:FRX_TEST_XUL_SHA --mcp-root `"$mcp`" --output `"$out\ENVIRONMENT-LIFECYCLE.json`""
  Step "fingerprint" "$out\FINGERPRINT-REPORT.json" "node scripts\verify-native-fingerprint.mjs --firefox `"$env:FRX_TEST_BINARY`" --xul-sha256 $env:FRX_TEST_XUL_SHA --mcp-root `"$mcp`" --allow-unavailable-webgl --context-type tab --report-output `"$out\FINGERPRINT-REPORT.json`""
  Step "global-prompt" "$out\global-system-prompt\report.json" "python scripts\verify-global-system-prompt.py --app `"$env:FRX_TEST_BINARY`" --source-commit $env:SOURCE_COMMIT --build-id $env:EXPECTED_BUILD_ID --bundle-sha256 $env:FRX_TEST_BUNDLE_SHA --output `"$out\global-system-prompt`""
  Step "windows-package" (Join-Path $repo "native-report\windows-native-report.json") "python scripts\verify-windows-package.py"
  if (Test-Path (Join-Path $repo "native-report")) { Copy-Item -Recurse -Force (Join-Path $repo "native-report") (Join-Path $out "windows-native-report") }
  $xul = Join-Path (Split-Path $env:FRX_TEST_BINARY) "xul.dll"
  $after = if (Test-Path $xul) { (Get-FileHash -Algorithm SHA256 $xul).Hash.ToLower() } else { "" }
  Log ("xul unchanged: " + ($after -eq $env:FRX_TEST_XUL_SHA))
}
Start-Sleep -Seconds 2
Log ("leftover firefox: " + @(Get-Process -Name firefox -ErrorAction SilentlyContinue).Count)
Log "DONE"
