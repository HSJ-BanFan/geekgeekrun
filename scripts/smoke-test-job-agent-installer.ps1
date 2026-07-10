param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$BrowserArchivePath = ""
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

function Get-Sha256 {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Wait-ForFixtureReady {
    param([string]$ReadyFile, $Process, [string]$ErrorFile)

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $ReadyFile) {
            return
        }
        if ($Process.HasExited) {
            $stderr = if (Test-Path -LiteralPath $ErrorFile) { Get-Content -Raw -LiteralPath $ErrorFile } else { "" }
            throw "BROWSER_FIXTURE_EXITED ($($Process.ExitCode))`n$stderr"
        }
        Start-Sleep -Milliseconds 200
    }
    throw "BROWSER_FIXTURE_TIMEOUT"
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
$savedPythonPath = $env:PYTHONPATH
$fixtureProcess = $null
$fixtureStopFile = ""

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
    $env:PATH = "$installRoot;$env:SystemRoot\System32"
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    $ggr = (Get-Command "ggr.cmd" -ErrorAction Stop).Source
    $sidecar = (Get-Command "ggr-sidecar.cmd" -ErrorAction Stop).Source
    Assert-True -Condition ($ggr.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -Label "fresh PATH resolves installed ggr"
    Assert-True -Condition ($sidecar.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -Label "fresh PATH resolves installed ggr-sidecar"
    foreach ($tool in @("node", "node.exe", "python", "python.exe", "py", "py.exe", "pnpm", "pnpm.cmd", "pip", "pip.exe")) {
        Assert-True -Condition ($null -eq (Get-Command $tool -ErrorAction SilentlyContinue)) -Label "$tool is absent from installed-product PATH"
    }

    $version = Invoke-InstalledJson -Command $ggr -Arguments @("--version")
    Assert-True -Condition ($version.runtimeMode -eq "installed") -Label "installed version runtime mode"
    $doctor = Invoke-InstalledJson -Command $ggr -Arguments @("doctor")
    Assert-True -Condition ($doctor.ok -eq $true) -Label "fresh installation doctor"
    Assert-True -Condition ($doctor.checks.installation.componentChecks.credentialCleanup.ready -eq $true) -Label "credential cleanup component integrity"
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

    New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
    $browserMetadata = Get-Content -Raw -LiteralPath (Join-Path $installRoot "app\browser-distribution.json") | ConvertFrom-Json
    $archivePath = if ($BrowserArchivePath) {
        [System.IO.Path]::GetFullPath($BrowserArchivePath)
    } else {
        $downloadPath = Join-Path $fixtureRoot "chrome-win64.zip"
        $savedProgressPreference = $ProgressPreference
        try {
            $ProgressPreference = "SilentlyContinue"
            Invoke-WebRequest -UseBasicParsing -Uri ([string]$browserMetadata.url) -OutFile $downloadPath
        } finally {
            $ProgressPreference = $savedProgressPreference
        }
        $downloadPath
    }
    Assert-True -Condition (Test-Path -LiteralPath $archivePath -PathType Leaf) -Label "pinned browser archive available"
    $archiveHash = Get-Sha256 -Path $archivePath
    Assert-True -Condition ($archiveHash -eq [string]$browserMetadata.sha256) -Label "pinned browser archive checksum"
    $setup = Invoke-InstalledJson -Command $ggr -Arguments @(
        "setup", "--offline-archive", $archivePath, "--skip-login"
    )
    Assert-True -Condition ($setup.browser.selectionMode -eq "managed") -Label "offline browser provisioning"

    $fixturePort = Get-FreeTcpPort
    $fixtureReadyFile = Join-Path $fixtureRoot "ready.json"
    $fixtureStopFile = Join-Path $fixtureRoot "stop"
    $fixtureStoppedFile = Join-Path $fixtureRoot "stopped.json"
    $fixtureStdoutFile = Join-Path $fixtureRoot "fixture.stdout.log"
    $fixtureStderrFile = Join-Path $fixtureRoot "fixture.stderr.log"
    $fixtureScript = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\job-agent-browser-fixture.mjs"
    $fixtureProcess = Start-Process -FilePath (Join-Path $installRoot "runtime\node.exe") -ArgumentList @(
        "`"$fixtureScript`"",
        "--install-root", "`"$installRoot`"",
        "--browser-executable", "`"$([string]$setup.browser.executablePath)`"",
        "--port", [string]$fixturePort,
        "--ready-file", "`"$fixtureReadyFile`"",
        "--stop-file", "`"$fixtureStopFile`"",
        "--stopped-file", "`"$fixtureStoppedFile`""
    ) -RedirectStandardOutput $fixtureStdoutFile -RedirectStandardError $fixtureStderrFile -PassThru -WindowStyle Hidden
    Wait-ForFixtureReady -ReadyFile $fixtureReadyFile -Process $fixtureProcess -ErrorFile $fixtureStderrFile

    $marketCapture = Invoke-InstalledJson -Command $ggr -Arguments @(
        "market-jobs", "--from-browser", "--keyword", "AI Agent", "--city", "101020100", "--limit", "1",
        "--cdp-port", [string]$fixturePort, "--output", (Join-Path $testRoot "browser-market.json")
    )
    Assert-True -Condition ($marketCapture.ok -eq $true -and $marketCapture.jobCount -eq 1) -Label "installed Market browser capture"
    Assert-True -Condition ($marketCapture.browserConnection.mode -eq "loopback") -Label "installed Market loopback CDP"

    $recentCapture = Invoke-InstalledJson -Command $ggr -Arguments @(
        "recent-applications", "--from-browser", "--limit", "1", "--cdp-port", [string]$fixturePort,
        "--output", (Join-Path $testRoot "browser-recent.json")
    )
    Assert-True -Condition ($recentCapture.ok -eq $true -and $recentCapture.recordCount -eq 1) -Label "installed Recent Applications browser capture"
    Set-Content -LiteralPath $fixtureStopFile -Value "stop"
    $fixtureExited = $fixtureProcess.WaitForExit(30000)
    if ($fixtureExited) {
        $fixtureProcess.WaitForExit()
    }
    $fixtureProcess.Refresh()
    $fixtureStopped = if (Test-Path -LiteralPath $fixtureStoppedFile) {
        Get-Content -Raw -LiteralPath $fixtureStoppedFile | ConvertFrom-Json
    } else {
        $null
    }
    $fixtureStoppedOk = $null -ne $fixtureStopped -and $fixtureStopped.ok -eq $true
    if (-not $fixtureExited -or -not $fixtureProcess.HasExited -or -not $fixtureStoppedOk) {
        $fixtureError = if (Test-Path -LiteralPath $fixtureStderrFile) { Get-Content -Raw -LiteralPath $fixtureStderrFile } else { "" }
        throw "INSTALLER_SMOKE_FAILED: browser fixture clean shutdown (waited=$fixtureExited exited=$($fixtureProcess.HasExited) stopped=$fixtureStoppedOk)`n$fixtureError"
    }
    $fixtureProcess = $null

    $jobPath = Join-Path $testRoot "authorized-job.json"
    $finalDecisionPath = Join-Path $testRoot "final-decision.json"
    $llmEvaluationPath = Join-Path $testRoot "llm-evaluation.json"
    $tokenFile = Join-Path $testRoot "authorization-tokens.json"
    $auditFile = Join-Path $testRoot "authorization-audit.jsonl"
    [ordered]@{
        jobId = "fixture-authorized-job-1"
        title = "AI Agent Engineer"
        company = "Fixture Technology"
        city = "Shanghai"
        jd = "Responsibilities include AI Agent service development, tool integration, automation workflows, and production deployment."
    } | ConvertTo-Json | Set-Content -LiteralPath $jobPath -Encoding UTF8
    [ordered]@{
        decision = "apply"
        source = "llm"
        reason = "Complete fixture evidence supports the controlled dry-run."
    } | ConvertTo-Json | Set-Content -LiteralPath $finalDecisionPath -Encoding UTF8
    [ordered]@{
        decision = "apply"
        reason = "Fixture decision with complete evidence."
        resume_fit = "Fixture resume evidence matches the role."
        intent_fit = "Fixture role matches the declared target direction."
        recall_context = "Fixture role came from the requested AI Agent market context."
        attention_technology_assessment = @{ explanation = "No mismatch was found in the fixture evidence." }
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $llmEvaluationPath -Encoding UTF8
    $issued = Invoke-InstalledJson -Command $ggr -Arguments @(
        "authorization-token", "issue", "--run-id", "installer-smoke-authorized-action", "--job", $jobPath,
        "--final-decision", $finalDecisionPath, "--llm-evaluation", $llmEvaluationPath,
        "--allowed-action", "start_chat", "--token-file", $tokenFile,
        "--now", "2026-07-10T10:00:00.000Z", "--ttl-ms", "600000"
    )
    Assert-True -Condition ($issued.issued -eq $true) -Label "installed authorization token issue"
    $dryRun = Invoke-InstalledJson -Command $ggr -Arguments @(
        "authorized-action", "--action", "start_chat", "--token-id", ([string]$issued.token.tokenId),
        "--token-file", $tokenFile, "--audit-file", $auditFile, "--now", "2026-07-10T10:00:30.000Z"
    )
    Assert-True -Condition ($dryRun.ok -eq $true -and $dryRun.dryRun -eq $true -and $dryRun.reasonCode -eq "DRY_RUN") -Label "installed controlled action dry-run"
    $tokenStatus = Invoke-InstalledJson -Command $ggr -Arguments @(
        "authorization-token", "inspect", "--token-id", ([string]$issued.token.tokenId),
        "--token-file", $tokenFile, "--action", "start_chat", "--now", "2026-07-10T10:00:30.000Z"
    )
    Assert-True -Condition ($tokenStatus.token.consumption.state -eq "unconsumed") -Label "dry-run leaves authorization token unconsumed"

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
        installedBrowserCaptureVerified = $true
        controlledActionDryRunVerified = $true
        externalToolchainsAbsent = $true
    } | ConvertTo-Json -Depth 3
} finally {
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
        if ($fixtureStopFile) {
            Set-Content -LiteralPath $fixtureStopFile -Value "stop" -ErrorAction SilentlyContinue
            $fixtureProcess.WaitForExit(10000) | Out-Null
        }
        if (-not $fixtureProcess.HasExited) {
            Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    $env:PATH = $savedProcessPath
    if ($null -eq $savedPythonPath) {
        Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    } else {
        $env:PYTHONPATH = $savedPythonPath
    }
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
