param(
    [Parameter(Mandatory = $true)]
    [string]$BundleRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-PortableText {
    param([string]$Command, [string[]]$Arguments)

    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "ggr-portable-stderr-$PID-$([Guid]::NewGuid().ToString('N')).txt"
    try {
        $stdoutLines = & $Command @Arguments 2> $stderrPath
        $exitCode = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { "" }
        if ($exitCode -ne 0) {
            throw "PORTABLE_SMOKE_COMMAND_FAILED ($exitCode): $Command $($Arguments -join ' ')`n$stderr"
        }
        if ($stderr) {
            throw "PORTABLE_SMOKE_STDERR_NOT_EMPTY: $Command $($Arguments -join ' ')`n$stderr"
        }
        return ($stdoutLines -join [Environment]::NewLine)
    } finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-PortableJson {
    param([string]$Command, [string[]]$Arguments)

    return (Invoke-PortableText -Command $Command -Arguments $Arguments) | ConvertFrom-Json
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)

    if ($Actual -ne $Expected) {
        throw "PORTABLE_SMOKE_FAILED: $Label expected '$Expected' but found '$Actual'"
    }
}

$bundle = [System.IO.Path]::GetFullPath($BundleRoot)
$ggr = Join-Path $bundle "ggr.cmd"
$sidecar = Join-Path $bundle "ggr-sidecar.cmd"
$manifestPath = Join-Path $bundle "job-agent-installation-manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$unrelatedRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ggr-portable-smoke-$PID"
$runtimeHome = Join-Path $unrelatedRoot "runtime-home"
$workingDirectory = Join-Path $unrelatedRoot "unrelated-working-directory"

New-Item -ItemType Directory -Force -Path $workingDirectory | Out-Null
$savedPath = $env:PATH
$savedPythonPath = $env:PYTHONPATH
$savedRuntimeHome = $env:GGR_JOB_AGENT_HOME

try {
    $env:PATH = Join-Path $env:SystemRoot "System32"
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    $env:GGR_JOB_AGENT_HOME = $runtimeHome
    Push-Location $workingDirectory
    try {
        $version = Invoke-PortableJson -Command $ggr -Arguments @("--version")
        Assert-Equal $version.runtimeMode "installed" "version runtime mode"
        Assert-Equal $version.distribution.version $manifest.distributionVersion "version distribution"

        $doctor = Invoke-PortableJson -Command $ggr -Arguments @("doctor")
        Assert-Equal $doctor.ok $true "doctor result"
        Assert-Equal $doctor.checks.installation.integrity "verified" "doctor integrity"
        Assert-Equal $doctor.features.openaiAgentsSdk $false "optional Agents SDK feature"

        $plan = Invoke-PortableJson -Command $ggr -Arguments @(
            "market-jobs", "--plan-only", "--keyword", "AI Agent", "--city", "101020100", "--limit", "1"
        )
        Assert-Equal $plan.ok $true "plan-only result"
        Assert-Equal $plan.mode "plan-only" "plan-only mode"
        if (-not [System.IO.Path]::IsPathRooted([string]$plan.rawArtifactPath)) {
            throw "PORTABLE_SMOKE_FAILED: plan-only artifact path is not absolute"
        }
        if (-not ([string]$plan.rawArtifactPath).StartsWith($runtimeHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "PORTABLE_SMOKE_FAILED: default artifact path is outside the isolated runtime home"
        }

        $toolCli = Invoke-PortableJson -Command (Join-Path $bundle "runtime\node.exe") -Arguments @(
            "--no-warnings", (Join-Path $bundle "app\bin\ggr-main.mjs"), "portable-smoke"
        )
        if ($toolCli.commands -notcontains "ggr run-batch --from-browser --llm --confirm [--target-count 20] [--max-candidates 160] [--candidate-timeout-ms 240000] [--progress-file file]") {
            throw "PORTABLE_SMOKE_FAILED: the built Node CLI command surface is incomplete"
        }

        $sidecarVersion = Invoke-PortableJson -Command $sidecar -Arguments @("version")
        Assert-Equal $sidecarVersion.distribution.version $manifest.distributionVersion "frozen sidecar version"

        $agentVersion = Invoke-PortableJson -Command $ggr -Arguments @("agent", "version")
        Assert-Equal $agentVersion.distribution.version $manifest.distributionVersion "ggr agent sidecar dispatch"

        $snapshot = Invoke-PortableJson -Command $ggr -Arguments @("snapshot")
        Assert-Equal $snapshot.command "snapshot" "installed existing CLI surface"
        if (-not ([string]$snapshot.storageFilePath).StartsWith($runtimeHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "PORTABLE_SMOKE_FAILED: installed snapshot did not use isolated data storage"
        }

        $configPath = Invoke-PortableJson -Command $ggr -Arguments @("config", "path")
        if (-not ([string]$configPath.configRoot).StartsWith($runtimeHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "PORTABLE_SMOKE_FAILED: installed config path is outside the isolated runtime home"
        }

        $sidecarHelp = Invoke-PortableText -Command $sidecar -Arguments @("--help")
        if ($sidecarHelp -notmatch "(?i)usage:\s+ggr-sidecar") {
            throw "PORTABLE_SMOKE_FAILED: ggr-sidecar --help did not expose the expected command"
        }
    } finally {
        Pop-Location
    }

    [ordered]@{
        ok = $true
        command = "smoke-test-job-agent-portable"
        bundleRoot = $bundle
        manifestPath = $manifestPath
        workingDirectory = $workingDirectory
        systemRuntimePathOnly = $true
        pythonPathAbsent = $true
    } | ConvertTo-Json -Depth 3
} finally {
    $env:PATH = $savedPath
    if ($null -eq $savedPythonPath) {
        Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    } else {
        $env:PYTHONPATH = $savedPythonPath
    }
    if ($null -eq $savedRuntimeHome) {
        Remove-Item Env:GGR_JOB_AGENT_HOME -ErrorAction SilentlyContinue
    } else {
        $env:GGR_JOB_AGENT_HOME = $savedRuntimeHome
    }
    if (Test-Path -LiteralPath $unrelatedRoot) {
        Remove-Item -LiteralPath $unrelatedRoot -Recurse -Force
    }
}
