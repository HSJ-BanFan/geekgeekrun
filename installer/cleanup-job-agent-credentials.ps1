param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$operatorConfigPath = Join-Path $env:USERPROFILE ".geekgeekrun-job-agent\config\operator.json"
if (-not (Test-Path -LiteralPath $operatorConfigPath -PathType Leaf)) {
    exit 0
}
$helperPath = Join-Path $InstallRoot "app\src\windows-credential.ps1"
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "CREDENTIAL_CLEANUP_HELPER_MISSING"
}
$operator = Get-Content -Raw -LiteralPath $operatorConfigPath | ConvertFrom-Json
$credentials = $operator.credentials
if ($null -eq $credentials) {
    exit 0
}
foreach ($property in @($credentials.PSObject.Properties)) {
    $reference = [string]$property.Value
    if (-not $reference.StartsWith("windows-credential:", [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
    }
    $target = $reference.Substring("windows-credential:".Length)
    if ($target -notmatch '^GeekGeekRun/JobAgent/[A-Za-z0-9._-]+$') {
        continue
    }
    & $helperPath -Action delete -Target $target | Out-Null
}
