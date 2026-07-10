param(
    [string]$PortableBundleRoot = "",
    [string]$OutputDirectory = "",
    [string]$InnoCompiler = ""
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

function Resolve-InnoCompiler {
    param([string]$ConfiguredCompiler)

    if ($ConfiguredCompiler) {
        $resolved = [System.IO.Path]::GetFullPath($ConfiguredCompiler)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "INNO_COMPILER_NOT_FOUND: $resolved"
        }
        return $resolved
    }
    $command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $default = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    if (Test-Path -LiteralPath $default -PathType Leaf) {
        return $default
    }
    throw "INNO_COMPILER_NOT_FOUND: install Inno Setup 6 or pass -InnoCompiler"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $repoRoot "packages\job-agent-cli\distribution-metadata.json"
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$distributionVersion = [string]$metadata.distributionVersion

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot "artifacts\job-agent-installer"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

if (-not $PortableBundleRoot) {
    Invoke-Checked -Executable "powershell" -Arguments @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $repoRoot "scripts\build-job-agent-portable.ps1")
    )
    $PortableBundleRoot = Join-Path $repoRoot "artifacts\job-agent-portable\geekgeekrun-job-agent-$distributionVersion-win-x64"
}
$bundleRoot = [System.IO.Path]::GetFullPath($PortableBundleRoot)
$manifestPath = Join-Path $bundleRoot "job-agent-installation-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "PORTABLE_MANIFEST_NOT_FOUND: $manifestPath"
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ([string]$manifest.distributionVersion -ne $distributionVersion) {
    throw "DISTRIBUTION_VERSION_MISMATCH: portable bundle $($manifest.distributionVersion) != $distributionVersion"
}

$compiler = Resolve-InnoCompiler -ConfiguredCompiler $InnoCompiler
$installerScript = Join-Path $repoRoot "installer\job-agent-installer.iss"
Invoke-Checked -Executable $compiler -Arguments @(
    "/DBundleRoot=$bundleRoot",
    "/DOutputDir=$outputRoot",
    "/DDistributionVersion=$distributionVersion",
    $installerScript
)

$installerPath = Join-Path $outputRoot "geekgeekrun-job-agent-$distributionVersion-win-x64-setup.exe"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "INSTALLER_BUILD_OUTPUT_MISSING: $installerPath"
}
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()

[ordered]@{
    ok = $true
    command = "build-job-agent-installer"
    distributionVersion = $distributionVersion
    target = "windows-x64"
    installerPath = $installerPath
    sha256 = $hash
    perUser = $true
    requiresElevation = $false
} | ConvertTo-Json -Depth 4
