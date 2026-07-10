param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

$repoRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $repoRoot "packages\job-agent-cli\browser-distribution.json"
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot "artifacts\job-agent-browser-fixture\chrome-win64.zip"
}
$archivePath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archivePath) | Out-Null

if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    $temporaryPath = "$archivePath.download"
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    $savedProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -UseBasicParsing -Uri ([string]$metadata.url) -OutFile $temporaryPath
        Move-Item -LiteralPath $temporaryPath -Destination $archivePath -Force
    } finally {
        $ProgressPreference = $savedProgressPreference
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

$actualHash = Get-Sha256 -Path $archivePath
if ($actualHash -ne [string]$metadata.sha256) {
    throw "BROWSER_ARCHIVE_HASH_MISMATCH: expected $($metadata.sha256) but found $actualHash"
}

[ordered]@{
    ok = $true
    command = "download-job-agent-browser-fixture"
    browserVersion = [string]$metadata.version
    archivePath = $archivePath
    sha256 = $actualHash
} | ConvertTo-Json -Depth 3
