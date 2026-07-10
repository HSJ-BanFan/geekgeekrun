param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "COMMAND_FAILED ($LASTEXITCODE): $Executable $($Arguments -join ' ')"
    }
}

function Invoke-InstallerProcess {
    param([string]$Executable, [string[]]$Arguments)

    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "INSTALLER_PROCESS_FAILED ($($process.ExitCode)): $Executable $($Arguments -join ' ')"
    }
}

function Invoke-InstalledText {
    param([string]$Command, [string[]]$Arguments)

    $stderrPath = Join-Path $testRoot "stderr-$([Guid]::NewGuid().ToString('N')).txt"
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $stdoutLines = & $Command @Arguments 2> $stderrPath
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $savedErrorActionPreference
        $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { "" }
        if ($exitCode -ne 0) {
            throw "INSTALLED_COMMAND_FAILED ($exitCode): $Command $($Arguments -join ' ')`nstdout:`n$($stdoutLines -join [Environment]::NewLine)`nstderr:`n$stderr"
        }
        return ($stdoutLines -join [Environment]::NewLine)
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-InstalledJson {
    param([string]$Command, [string[]]$Arguments)

    return (Invoke-InstalledText -Command $Command -Arguments $Arguments) | ConvertFrom-Json
}

function Assert-True {
    param([bool]$Condition, [string]$Label)

    if (-not $Condition) {
        throw "INSTALLER_SMOKE_FAILED: $Label"
    }
}

function Assert-PathWithin {
    param([string]$Path, [string]$Root)

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $resolvedPath.StartsWith("$resolvedRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "UNSAFE_TEST_PATH: $resolvedPath"
    }
}

$installer = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "INSTALLER_NOT_FOUND: $installer"
}
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ggr-installer-smoke-$PID"
$installRoot = Join-Path $testRoot "install"
$fixtureRoot = Join-Path $testRoot "browser-fixture"
$runtimeHome = Join-Path $env:USERPROFILE ".geekgeekrun-job-agent"
$credentialTarget = "GeekGeekRun/JobAgent/installer-smoke-$PID"
$powerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$savedProcessPath = $env:PATH

Assert-PathWithin -Path $installRoot -Root ([System.IO.Path]::GetTempPath())
if (Test-Path -LiteralPath $runtimeHome) {
    throw "INSTALLER_SMOKE_RUNTIME_HOME_EXISTS: refusing to touch $runtimeHome"
}
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

try {
    Invoke-InstallerProcess -Executable $installer -Arguments @(
        "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$installRoot"
    )
    $userPathAfterInstall = [Environment]::GetEnvironmentVariable("Path", "User")
    Assert-True -Condition ($userPathAfterInstall.Split(';') -contains $installRoot) -Label "launcher directory added to user PATH"
    $env:PATH = "$userPathAfterInstall;$env:SystemRoot\System32"
    $ggr = (Get-Command "ggr.cmd" -ErrorAction Stop).Source
    $sidecar = (Get-Command "ggr-sidecar.cmd" -ErrorAction Stop).Source
    Assert-True -Condition ($ggr.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -Label "fresh PATH resolves installed ggr"
    Assert-True -Condition ($sidecar.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -Label "fresh PATH resolves installed ggr-sidecar"

    $version = Invoke-InstalledJson -Command $ggr -Arguments @("--version")
    Assert-True -Condition ($version.runtimeMode -eq "installed") -Label "installed version runtime mode"
    $doctor = Invoke-InstalledJson -Command $ggr -Arguments @("doctor")
    Assert-True -Condition ($doctor.ok -eq $true) -Label "fresh installation doctor"
    $plan = Invoke-InstalledJson -Command $ggr -Arguments @(
        "market-jobs", "--plan-only", "--keyword", "AI Agent", "--city", "101020100", "--limit", "1"
    )
    Assert-True -Condition ([System.IO.Path]::IsPathRooted([string]$plan.rawArtifactPath)) -Label "default artifact path absolute"
    Assert-True -Condition ([string]$plan.rawArtifactPath).StartsWith($runtimeHome, [System.StringComparison]::OrdinalIgnoreCase) -Label "default artifact isolated"

    Push-Location $testRoot
    try {
        $relativePlan = Invoke-InstalledJson -Command $ggr -Arguments @(
            "market-jobs", "--plan-only", "--keyword", "AI Agent", "--city", "101020100", "--limit", "1",
            "--output", "reports\market.json"
        )
    } finally {
        Pop-Location
    }
    Assert-True -Condition ([string]$relativePlan.rawArtifactPath -eq (Join-Path $testRoot "reports\market.json")) -Label "caller-relative artifact path"
    $sidecarVersion = Invoke-InstalledJson -Command $sidecar -Arguments @("version")
    Assert-True -Condition ($sidecarVersion.distribution.version -eq $version.distribution.version) -Label "direct sidecar version"
    $agentVersion = Invoke-InstalledJson -Command $ggr -Arguments @("agent", "version")
    Assert-True -Condition ($agentVersion.distribution.version -eq $version.distribution.version) -Label "ggr agent dispatch"

    $archiveContentRoot = Join-Path $fixtureRoot "content"
    $chromeRoot = Join-Path $archiveContentRoot "chrome-win64"
    $archivePath = Join-Path $fixtureRoot "chrome.zip"
    $metadataPath = Join-Path $fixtureRoot "browser-metadata.json"
    New-Item -ItemType Directory -Force -Path $chromeRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $installRoot "runtime\node.exe") -Destination (Join-Path $chromeRoot "chrome.exe")
    Invoke-Checked -Executable "tar.exe" -Arguments @("-c", "-a", "-f", $archivePath, "-C", $archiveContentRoot, "chrome-win64")
    $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    [ordered]@{
        schemaVersion = "job-agent-browser-distribution.v1"
        product = "chrome-for-testing"
        platform = "win64"
        version = "140.0.7339.80"
        url = "https://example.invalid/chrome.zip"
        sha256 = $archiveHash
        archiveRoot = "chrome-win64"
        executableRelativePath = "chrome-win64/chrome.exe"
    } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    $setup = Invoke-InstalledJson -Command $ggr -Arguments @(
        "setup", "--offline-archive", $archivePath, "--browser-metadata", $metadataPath, "--skip-login"
    )
    Assert-True -Condition ($setup.browser.selectionMode -eq "managed") -Label "offline browser provisioning"

    Invoke-InstalledJson -Command $ggr -Arguments @("config", "init") | Out-Null
    $credentialHelper = Join-Path $installRoot "app\src\windows-credential.ps1"
    "installer-smoke-secret" | & $powerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $credentialHelper -Action set -Target $credentialTarget | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "INSTALLER_SMOKE_FAILED: could not seed Credential Manager" }
    $operatorPath = Join-Path $runtimeHome "config\operator.json"
    $operator = Get-Content -Raw -LiteralPath $operatorPath | ConvertFrom-Json
    $operator.credentials | Add-Member -NotePropertyName "installer-smoke" -NotePropertyValue "windows-credential:$credentialTarget" -Force
    $operator | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $operatorPath -Encoding UTF8
    New-Item -ItemType Directory -Force -Path (Join-Path $runtimeHome "tokens"), (Join-Path $runtimeHome "temp"), (Join-Path $runtimeHome "data"), (Join-Path $runtimeHome "audit"), (Join-Path $runtimeHome "artifacts") | Out-Null
    Set-Content -LiteralPath (Join-Path $runtimeHome "tokens\token.json") -Value "sensitive"
    Set-Content -LiteralPath (Join-Path $runtimeHome "temp\temp.txt") -Value "sensitive"
    Set-Content -LiteralPath (Join-Path $runtimeHome "data\public.db") -Value "sensitive"
    Set-Content -LiteralPath (Join-Path $runtimeHome "audit\audit.jsonl") -Value "redacted"
    Set-Content -LiteralPath (Join-Path $runtimeHome "artifacts\artifact.json") -Value "redacted"

    $uninstaller = Join-Path $installRoot "unins000.exe"
    Invoke-InstallerProcess -Executable $uninstaller -Arguments @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART")
    Assert-True -Condition (-not (Test-Path -LiteralPath $installRoot)) -Label "uninstall removes installed runtimes"
    $userPathAfterUninstall = [Environment]::GetEnvironmentVariable("Path", "User")
    Assert-True -Condition (-not ($userPathAfterUninstall.Split(';') -contains $installRoot)) -Label "uninstall removes PATH entry"
    foreach ($sensitiveDirectory in @("browser", "tokens", "temp", "data")) {
        Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $runtimeHome $sensitiveDirectory))) -Label "uninstall removes $sensitiveDirectory"
    }
    foreach ($preservedDirectory in @("config", "audit", "artifacts")) {
        Assert-True -Condition (Test-Path -LiteralPath (Join-Path $runtimeHome $preservedDirectory)) -Label "uninstall preserves $preservedDirectory"
    }
    $sourceCredentialHelper = Join-Path (Split-Path -Parent $PSScriptRoot) "packages\job-agent-cli\src\windows-credential.ps1"
    $credentialStatus = & $powerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $sourceCredentialHelper -Action exists -Target $credentialTarget | ConvertFrom-Json
    Assert-True -Condition ($credentialStatus.exists -eq $false) -Label "uninstall removes Windows Credential Manager secrets"

    Invoke-InstallerProcess -Executable $installer -Arguments @(
        "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$installRoot"
    )
    $uninstaller = Join-Path $installRoot "unins000.exe"
    Invoke-InstallerProcess -Executable $uninstaller -Arguments @(
        "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/GGRREMOVEALL=1"
    )
    Assert-True -Condition (-not (Test-Path -LiteralPath $runtimeHome)) -Label "complete removal deletes all Job Agent data"

    [ordered]@{
        ok = $true
        command = "smoke-test-job-agent-installer"
        installerPath = $installer
        installRoot = $installRoot
        perUserPathVerified = $true
        privacyFirstUninstallVerified = $true
        completeRemovalVerified = $true
    } | ConvertTo-Json -Depth 3
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    $env:PATH = $savedProcessPath
    if (Test-Path -LiteralPath $installRoot) {
        $uninstaller = Join-Path $installRoot "unins000.exe"
        if (Test-Path -LiteralPath $uninstaller) {
            $cleanupProcess = Start-Process -FilePath $uninstaller -ArgumentList @(
                "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/GGRREMOVEALL=1"
            ) -Wait -PassThru -WindowStyle Hidden
        }
    }
    if (Test-Path -LiteralPath $runtimeHome) {
        Remove-Item -LiteralPath $runtimeHome -Recurse -Force
    }
    $sourceCredentialHelper = Join-Path (Split-Path -Parent $PSScriptRoot) "packages\job-agent-cli\src\windows-credential.ps1"
    if (Test-Path -LiteralPath $sourceCredentialHelper) {
        & $powerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $sourceCredentialHelper -Action delete -Target $credentialTarget | Out-Null
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
