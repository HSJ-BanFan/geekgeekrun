param(
    [string]$OutputDirectory = "",
    [string]$NodeArchive = "",
    [string]$PythonExecutable = ""
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

function Invoke-PortableSmoke {
    param([string]$BundleRoot)

    Invoke-Checked -Executable "powershell" -Arguments @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $repoRoot "scripts\smoke-test-job-agent-portable.ps1"),
        "-BundleRoot", $BundleRoot
    )
}

function Assert-Python311 {
    param($Python)

    $arguments = @($Python.Prefix) + @("-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    $executable = [string]$Python.Executable
    $version = (& $executable @arguments).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne "3.11") {
        throw "PYTHON_311_REQUIRED: found $version"
    }
}

function Resolve-Python311 {
    param([string]$ConfiguredExecutable)

    if ($ConfiguredExecutable) {
        $candidate = [ordered]@{ Executable = $ConfiguredExecutable; Prefix = @() }
        Assert-Python311 -Python $candidate
        return $candidate
    }
    if (Get-Command "py" -ErrorAction SilentlyContinue) {
        $candidate = [ordered]@{ Executable = "py"; Prefix = @("-3.11") }
        try {
            Assert-Python311 -Python $candidate
            return $candidate
        } catch {
        }
    }
    $fallback = [ordered]@{ Executable = "python"; Prefix = @() }
    Assert-Python311 -Python $fallback
    return $fallback
}

function Invoke-Python311 {
    param($Python, [string[]]$Arguments)

    Invoke-Checked -Executable ([string]$Python.Executable) -Arguments (@($Python.Prefix) + $Arguments)
}

function Remove-DirectoryWithin {
    param([string]$Path, [string]$Root)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $fullPath.StartsWith("$fullRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "UNSAFE_BUILD_PATH: $fullPath"
    }
    Remove-Item -LiteralPath $fullPath -Recurse -Force
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $repoRoot "packages\job-agent-cli\distribution-metadata.json"
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$distributionVersion = [string]$metadata.distributionVersion
$nodeVersion = "20.16.0"
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
$nodeArchiveSha256 = "4e88373ac5ae859ad4d50cc3c5fa86eb3178d089b72e64c4dbe6eeac5d7b5979"
$sidecarRequirementsPath = Join-Path $repoRoot "scripts\job-agent-portable-requirements.txt"
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json
if ([string]$rootPackage.packageManager -notmatch '^pnpm@(.+)$') {
    throw "PNPM_VERSION_INVALID: package.json packageManager must pin pnpm"
}
$pnpmVersion = $Matches[1]

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot "artifacts\job-agent-portable"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$bundleName = "geekgeekrun-job-agent-$distributionVersion-win-x64"
$bundleRoot = Join-Path $outputRoot $bundleName
$stagingRoot = Join-Path $outputRoot ".staging-$PID"
$archivePath = Join-Path $outputRoot "$bundleName.zip"
$deployScratchRoot = Join-Path $repoRoot "artifacts\job-agent-portable"
$deployRelativePath = "artifacts/job-agent-portable/.deploy-$PID"
$deployRoot = Join-Path $repoRoot $deployRelativePath

Remove-DirectoryWithin -Path $bundleRoot -Root $outputRoot
Remove-DirectoryWithin -Path $stagingRoot -Root $outputRoot
New-Item -ItemType Directory -Force -Path $deployScratchRoot | Out-Null
Remove-DirectoryWithin -Path $deployRoot -Root $deployScratchRoot
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}
New-Item -ItemType Directory -Force -Path $bundleRoot, $stagingRoot | Out-Null

try {
    Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "check-versions"
    )
    $python = Resolve-Python311 -ConfiguredExecutable $PythonExecutable

    $actualPnpmVersion = (& pnpm --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualPnpmVersion -ne $pnpmVersion) {
        throw "PNPM_VERSION_MISMATCH: expected $pnpmVersion but found $actualPnpmVersion"
    }

    Invoke-Checked -Executable "pnpm" -Arguments @(
        "--filter", "@geekgeekrun/job-agent-cli",
        "deploy", "--prod", "--frozen-lockfile", "--ignore-scripts", $deployRelativePath
    )
    $appRoot = Join-Path $bundleRoot "app"
    Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "materialize-node-app",
        "--source-root", $deployRoot,
        "--destination-root", $appRoot
    )
    Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "check-browser-compatibility",
        "--app-root", $appRoot
    )
    Get-ChildItem -LiteralPath (Join-Path $appRoot "src") -File -Filter "*.test.mjs" |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    $resolvedNodeArchive = if ($NodeArchive) {
        [System.IO.Path]::GetFullPath($NodeArchive)
    } else {
        $downloadPath = Join-Path $stagingRoot $nodeArchiveName
        Invoke-WebRequest -UseBasicParsing -Uri $nodeArchiveUrl -OutFile $downloadPath
        $downloadPath
    }
    if (-not (Test-Path -LiteralPath $resolvedNodeArchive -PathType Leaf)) {
        throw "NODE_ARCHIVE_NOT_FOUND: $resolvedNodeArchive"
    }
    $hashReport = (Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "hash-file",
        "--file", $resolvedNodeArchive
    )) | ConvertFrom-Json
    $actualNodeArchiveHash = [string]$hashReport.sha256
    if ($actualNodeArchiveHash -ne $nodeArchiveSha256) {
        throw "NODE_ARCHIVE_HASH_MISMATCH: expected $nodeArchiveSha256 but found $actualNodeArchiveHash"
    }
    $nodeExtractRoot = Join-Path $stagingRoot "node-runtime"
    Expand-Archive -LiteralPath $resolvedNodeArchive -DestinationPath $nodeExtractRoot
    $runtimeRoot = Join-Path $bundleRoot "runtime"
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeExtractRoot "node-v$nodeVersion-win-x64\node.exe") -Destination (Join-Path $runtimeRoot "node.exe")

    $venvRoot = Join-Path $stagingRoot "sidecar-venv"
    Invoke-Python311 -Python $python -Arguments @("-m", "venv", $venvRoot)
    $venvPython = Join-Path $venvRoot "Scripts\python.exe"
    Invoke-Checked -Executable $venvPython -Arguments @(
        "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
        "--requirement", $sidecarRequirementsPath
    )
    $generatedSidecarRoot = Join-Path $stagingRoot "sidecar-generated"
    $generatedSidecarVersionPath = Join-Path $generatedSidecarRoot "ggr_sidecar_build_version.py"
    Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "write-sidecar-build-version",
        "--output", $generatedSidecarVersionPath
    )
    $sidecarDistRoot = Join-Path $stagingRoot "sidecar-dist"
    Invoke-Checked -Executable $venvPython -Arguments @(
        "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--noupx",
        "--name", "ggr-sidecar",
        "--distpath", $sidecarDistRoot,
        "--workpath", (Join-Path $stagingRoot "sidecar-work"),
        "--specpath", (Join-Path $stagingRoot "sidecar-spec"),
        "--paths", $generatedSidecarRoot,
        "--paths", (Join-Path $repoRoot "packages\job-agent-sidecar\src"),
        "--hidden-import", "ggr_sidecar_build_version",
        "--exclude-module", "agents",
        "--exclude-module", "openai_agents",
        (Join-Path $repoRoot "scripts\job-agent-sidecar-entry.py")
    )
    $sidecarRoot = Join-Path $bundleRoot "sidecar"
    New-Item -ItemType Directory -Force -Path $sidecarRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $sidecarDistRoot "ggr-sidecar.exe") -Destination (Join-Path $sidecarRoot "ggr-sidecar.exe")

    $installerSupportRoot = Join-Path $bundleRoot "installer-support"
    New-Item -ItemType Directory -Force -Path $installerSupportRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "installer\cleanup-job-agent-credentials.ps1") `
        -Destination (Join-Path $installerSupportRoot "cleanup-job-agent-credentials.ps1")

    Invoke-Checked -Executable "node" -Arguments @(
        (Join-Path $repoRoot "scripts\job-agent-portable.mjs"),
        "--bundle-root", $bundleRoot,
        "--node-version", $nodeVersion
    )
    Invoke-PortableSmoke -BundleRoot $bundleRoot

    Invoke-Checked -Executable "tar.exe" -Arguments @("-c", "-a", "-f", $archivePath, "-C", $outputRoot, $bundleName)
    $archiveSmokeRoot = Join-Path $stagingRoot "archive-smoke"
    New-Item -ItemType Directory -Force -Path $archiveSmokeRoot | Out-Null
    Invoke-Checked -Executable "tar.exe" -Arguments @("-x", "-f", $archivePath, "-C", $archiveSmokeRoot)
    Invoke-PortableSmoke -BundleRoot (Join-Path $archiveSmokeRoot $bundleName)

    [ordered]@{
        ok = $true
        command = "build-job-agent-portable"
        distributionVersion = $distributionVersion
        target = "windows-x64"
        bundleRoot = $bundleRoot
        archivePath = $archivePath
        nodeVersion = $nodeVersion
        pythonBaseline = "3.11"
        openaiAgentsSdk = $false
    } | ConvertTo-Json -Depth 4
} finally {
    Remove-DirectoryWithin -Path $stagingRoot -Root $outputRoot
    Remove-DirectoryWithin -Path $deployRoot -Root $deployScratchRoot
}
